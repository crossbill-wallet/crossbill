"""Signs a PSBT the way Paperclip's Krux firmware does, on a computer, for Crossbill's tests.

It runs the firmware's own code (krux.qr.QRPartParser and krux.psbt.PSBTSigner, with Paperclip's embit), the
same path the device takes from "Load from camera" or "Load from SD card" to "Sign to QR code" or "Sign to SD
card". Only MicroPython's board, display and hardware modules are stood in for.

Reads one JSON request on stdin and writes one JSON answer on stdout:

  request:  {"mnemonic", "passphrase", "network": "main"|"test", "scriptType": "P2WPKH"|"P2SH_P2WPKH"|"P2PKH"|"P2TR",
             "account": 0, and either "qr": [parts in the order scanned] or "sd": "<base64 of the file's bytes>"}
  answer:   {"ok": true, "warnings": {...}, "review": [...], "qr": [parts the device shows]}  for "qr"
            {"ok": true, "warnings": {...}, "review": [...], "sd": "<base64 of the signed file>"}  for "sd"
            {"ok": false, "stage": "read"|"check"|"sign", "error": "..."}

Environment: KRUX_SRC is a checkout of github.com/connorslab/krux-blake2b. KRUX_EMBIT is the src folder of its
embit submodule (default KRUX_SRC/vendor/embit/src). KRUX_UUR is a folder holding a built uUR module, the
firmware's C library for UR codes; it is imported by krux.qr even though Crossbill uses BBQr. Use Python 3.11 or 3.12.
"""

import base64
import json
import os
import random
import sys
import time
import types
import zlib

KRUX_SRC = os.environ["KRUX_SRC"]
sys.path[:0] = [
    os.environ.get("KRUX_EMBIT", os.path.join(KRUX_SRC, "vendor", "embit", "src")),
    os.path.join(KRUX_SRC, "src"),
    os.environ.get("KRUX_UUR", ""),
]

# ---- stand-ins for MicroPython and MaixPy modules ------------------------------------------------------------
board = types.ModuleType("board")
board.config = {
    "type": "yahboom",
    "lcd": {"height": 240, "width": 320, "invert": 1, "dir": 96, "lcd_type": 0},
    "board_info": {"BOOT_KEY": 16, "CONNEXT_A": 8, "CONNEXT_B": 6},
    "krux": {
        "pins": {"BUTTON_B": 16, "BUTTON_C": 17, "TOUCH_IRQ": 22},
        "display": {"touch": True, "font": [8, 16], "font_wide": [16, 16]},
    },
}
qrcode = types.ModuleType("qrcode")
qrcode.encode = lambda data: data
b32 = types.ModuleType("base32")
b32.encode = lambda d, pad=False: base64.b32encode(d).decode().rstrip("=")
b32.decode = lambda s: base64.b32decode(s + "=" * ((8 - len(s) % 8) % 8))


class DeflateIO:
    """MicroPython's deflate.DeflateIO as Krux uses it, for raw deflate. Reading allows only the 1 KiB window
    BBQr's "Z" encoding specifies, so a stream needing more fails here as it could on a device. Writing uses
    the smallest window zlib offers (512 bytes); the device's default is 256."""

    def __init__(self, stream):
        self.stream = stream

    def write(self, data):
        c = zlib.compressobj(wbits=-9)
        self.stream.write(c.compress(data) + c.flush())

    def read(self):
        return zlib.decompress(self.stream.getvalue(), wbits=-10)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


deflate = types.ModuleType("deflate")
deflate.DeflateIO = DeflateIO
ucryptolib = types.ModuleType("ucryptolib")
ucryptolib.MODE_ECB, ucryptolib.MODE_CBC, ucryptolib.MODE_CTR, ucryptolib.MODE_GCM = 1, 2, 6, 11
for _name, _mod in {
    "board": board,
    "qrcode": qrcode,
    "urandom": random,
    "ujson": json,
    "base32": b32,
    "deflate": deflate,
    "ucryptolib": ucryptolib,
}.items():
    sys.modules[_name] = _mod
time.ticks_ms = lambda: int(time.time() * 1000)

from embit.networks import NETWORKS  # noqa: E402
from krux.key import Key, TYPE_SINGLESIG, P2WPKH, P2SH_P2WPKH, P2PKH, P2TR  # noqa: E402
from krux.wallet import Wallet  # noqa: E402
from krux.psbt import PSBTSigner  # noqa: E402
from krux.qr import FORMAT_NONE, FORMAT_PMOFN, FORMAT_BBQR, QRPartParser, to_qr_codes  # noqa: E402

TYPES = {"P2WPKH": P2WPKH, "P2SH_P2WPKH": P2SH_P2WPKH, "P2PKH": P2PKH, "P2TR": P2TR}
# The Yahboom's portrait screen: 240 pixels wide, 5 pixels per module, so QR codes up to 48 modules (version 7)
YAHBOOM_QR_WIDTH = 48


def all_parts(data, fmt):
    gen = to_qr_codes(data, YAHBOOM_QR_WIDTH, fmt)
    first, total = next(gen)
    parts = [first]
    for _ in range(total - 1):
        parts.append(next(gen)[0])
    return parts


def main():
    req = json.load(sys.stdin)
    net = NETWORKS["main" if req.get("network", "main") == "main" else "test"]
    key = Key(req["mnemonic"], TYPE_SINGLESIG, net, req.get("passphrase", ""), req.get("account", 0), TYPES[req["scriptType"]])
    wallet = Wallet(key)
    stage = "read"
    try:
        if "qr" in req:
            parser = QRPartParser()
            for part in req["qr"]:
                parser.parse(part)
            if not parser.is_complete():
                raise ValueError("incomplete: %d of %d parts" % (parser.parsed_count(), parser.total_count()))
            signer = PSBTSigner(wallet, parser.result(), parser.format)
        else:
            raw = base64.b64decode(req["sd"])
            signer = PSBTSigner(wallet, raw, FORMAT_NONE)
        stage = "check"
        signer.check_sighash()
        warnings = {"pathMismatch": bool(signer.path_mismatch()), "unverifiedAmounts": bool(signer.unverified_input_amounts())}
        review, fee_pct = signer.outputs()
        stage = "sign"
        out = {"ok": True, "warnings": warnings, "review": [str(m) for m in review], "feePercent": fee_pct}
        if "qr" in req:
            signer.sign()
            signed, fmt = signer.psbt_qr()
            if fmt not in (FORMAT_BBQR, FORMAT_PMOFN):
                raise ValueError("unexpected export format %r" % fmt)
            out["qr"] = all_parts(signed, fmt)
        else:
            signer.sign(trim=False)
            if signer.is_b64_file:
                signed, _ = signer.psbt_qr()
                out["sd"] = base64.b64encode(signed.encode() if isinstance(signed, str) else signed).decode()
            else:
                out["sd"] = base64.b64encode(signer.psbt.serialize()).decode()
        print(json.dumps(out))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "stage": stage, "error": "%s: %s" % (type(e).__name__, e)}))


if __name__ == "__main__":
    main()
