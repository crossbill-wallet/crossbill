# krux-check

`krux_sign.py` signs a PSBT with Paperclip's Krux firmware code, on a computer, so Crossbill's tests can check that what Crossbill hands the Krux is something it signs, and that Crossbill reads back what it returns. It runs the firmware's own QR reader (`krux.qr.QRPartParser`) and signer (`krux.psbt.PSBTSigner`), with Paperclip's embit, along the path the device takes from **Load from camera** or **Load from SD card** to **Sign to QR code** or **Sign to SD card**. Only MicroPython's board and hardware modules are stood in for.

It isn't the device: the review screens, the camera and the buttons aren't run. Try a small send on the real Krux before trusting it with more.

## Setting it up

You need Python 3.11 or 3.12, a C compiler, and Git.

```sh
git clone https://github.com/connorslab/krux-blake2b
git -C krux-blake2b submodule update --init vendor/embit

# The firmware's UR library, built for this Python. krux.psbt imports it even though Crossbill uses BBQr.
git clone https://github.com/selfcustody/cUR
python3.12 -m pip install --target uur ./cUR
```

## Running the tests with it

From the app's folder:

```sh
KRUX_SRC=/path/to/krux-blake2b KRUX_UUR=/path/to/uur KRUX_PYTHON=python3.12 npx vitest run tests/krux.test.ts
```

Add `KNOTS_BIN=/path/to/knots/build/bin` and run `tests/krux.e2e.test.ts` to have a BLAKE2b regtest node accept and mine what the firmware code signed. `KRUX_EMBIT` points at another embit checkout if it isn't the submodule.

## By hand

It reads one JSON request on stdin and writes one JSON answer:

```sh
echo '{"mnemonic": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
       "network": "main", "scriptType": "P2WPKH", "qr": ["B$ZP0100..."]}' | python3.12 krux_sign.py
```

`qr` holds the codes in the order they were scanned, or `sd` the base64 of a PSBT file. The answer has the warnings the Krux would show, its review text, and the codes it would show (`qr`) or the file it would save (`sd`). A refusal comes back as `{"ok": false, "stage": ..., "error": ...}`.
