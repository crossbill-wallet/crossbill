import com.sparrowwallet.drongo.*;
import com.sparrowwallet.drongo.address.Address;
import com.sparrowwallet.drongo.crypto.ECKey;
import com.sparrowwallet.drongo.policy.Policy;
import com.sparrowwallet.drongo.policy.PolicyType;
import com.sparrowwallet.drongo.protocol.*;
import com.sparrowwallet.drongo.psbt.PSBT;
import com.sparrowwallet.drongo.psbt.PSBTInput;
import com.sparrowwallet.drongo.wallet.*;

import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Produces reference vectors from Shrike's own drongo library, so the mobile wallet core can be checked
 * byte for byte against the desktop code: keys, descriptors (in the form Cormorant imports them),
 * addresses, and fully signed transactions with and without the unified opt-in.
 */
public class VectorGen {
    static final String WORDS_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    static final String WORDS_24 = "trouble stomach angle fiction fork tongue coconut enforce bridge pulse grit wild "
            + "absorb cousin wolf toward vocal grape cable pride exist sad copper muscle";

    static final ScriptType[] TYPES = {ScriptType.P2PKH, ScriptType.P2SH_P2WPKH, ScriptType.P2WPKH, ScriptType.P2TR};

    static String q(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    static String hex(byte[] b) {
        return Utils.bytesToHex(b);
    }

    static Wallet makeWallet(String words, String pass, ScriptType st) throws Exception {
        DeterministicSeed seed = new DeterministicSeed(words, pass, 0, DeterministicSeed.Type.BIP39);
        Wallet w = new Wallet();
        w.setPolicyType(PolicyType.SINGLE_HD);
        w.setScriptType(st);
        w.getKeystores().add(Keystore.fromSeed(seed, PolicyType.SINGLE_HD, st.getDefaultDerivation()));
        w.setDefaultPolicy(Policy.getPolicy(PolicyType.SINGLE_HD, st, w.getKeystores(), 1));
        return w;
    }

    static List<WalletNode> children(Wallet w, KeyPurpose purpose, int upTo) {
        WalletNode purposeNode = w.getNode(purpose);
        purposeNode.fillToIndex(w, upTo);
        List<WalletNode> nodes = new ArrayList<>(purposeNode.getChildren());
        nodes.sort(Comparator.comparingInt(WalletNode::getIndex));
        return nodes;
    }

    static String nodeJson(Wallet w, WalletNode n) {
        Keystore ks = w.getKeystores().get(0);
        return "{\"index\":" + n.getIndex()
                + ",\"path\":" + q(n.getDerivationPath())
                + ",\"address\":" + q(n.getAddress().toString())
                + ",\"scriptPubKey\":" + q(hex(n.getOutputScript().getProgram()))
                + ",\"pubkey\":" + q(hex(ks.getPubKey(n).getPubKey())) + "}";
    }

    static String walletJson(String netName, String words, String pass, ScriptType st) throws Exception {
        Wallet w = makeWallet(words, pass, st);
        Keystore ks = w.getKeystores().get(0);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"network\":").append(q(netName));
        sb.append(",\"mnemonic\":").append(q(words));
        sb.append(",\"passphrase\":").append(q(pass));
        sb.append(",\"scriptType\":").append(q(st.name()));
        sb.append(",\"fingerprint\":").append(q(ks.getKeyDerivation().getMasterFingerprint()));
        sb.append(",\"derivation\":").append(q(ks.getKeyDerivation().getDerivationPath()));
        sb.append(",\"xpub\":").append(q(ks.getExtendedPublicKey().toString()));
        for(KeyPurpose purpose : List.of(KeyPurpose.RECEIVE, KeyPurpose.CHANGE)) {
            OutputDescriptor od = OutputDescriptor.getOutputDescriptor(w, purpose);
            String key = purpose == KeyPurpose.RECEIVE ? "receive" : "change";
            sb.append(",\"").append(key).append("Descriptor\":{");
            sb.append("\"cormorant\":").append(q(od.toString(false, false)));
            sb.append(",\"cormorantNormalized\":").append(q(OutputDescriptor.normalize(od.toString(false, false))));
            sb.append(",\"withOrigin\":").append(q(od.toString(true, true)));
            sb.append("}");
        }
        sb.append(",\"receive\":[");
        List<WalletNode> recv = children(w, KeyPurpose.RECEIVE, 5);
        for(int i = 0; i < recv.size(); i++) {
            sb.append(i > 0 ? "," : "").append(nodeJson(w, recv.get(i)));
        }
        sb.append("],\"change\":[");
        List<WalletNode> chg = children(w, KeyPurpose.CHANGE, 5);
        for(int i = 0; i < chg.size(); i++) {
            sb.append(i > 0 ? "," : "").append(nodeJson(w, chg.get(i)));
        }
        sb.append("]}");
        return sb.toString();
    }

    static Transaction fundingTx(String tag, long[] values, Script[] scripts) {
        Transaction t = new Transaction();
        t.setVersion(2);
        t.addInput(Sha256Hash.of(tag.getBytes(StandardCharsets.UTF_8)), 0, new Script(new byte[] {0x51}));
        for(int i = 0; i < values.length; i++) {
            t.addOutput(values[i], scripts[i]);
        }
        return t;
    }

    static String signJson(String netName, String words, String pass, ScriptType st, boolean unified, int variant) throws Exception {
        Wallet w = makeWallet(words, pass, st);
        Keystore ks = w.getKeystores().get(0);
        List<WalletNode> recv = children(w, KeyPurpose.RECEIVE, 5);
        List<WalletNode> chg = children(w, KeyPurpose.CHANGE, 5);

        ECKey destKey = ECKey.fromPrivate(Sha256Hash.hash("shrike-dest".getBytes(StandardCharsets.UTF_8)));
        Script destScript = ScriptType.P2WPKH.getOutputScript(PolicyType.SINGLE_HD, destKey);
        Address destAddr = ScriptType.P2WPKH.getAddress(PolicyType.SINGLE_HD, destKey);
        ECKey otherKey = ECKey.fromPrivate(Sha256Hash.hash("shrike-other".getBytes(StandardCharsets.UTF_8)));
        Script otherScript = ScriptType.P2TR.getOutputScript(PolicyType.SINGLE_HD, otherKey);

        WalletNode in1Node = recv.get(variant == 0 ? 0 : 3);
        WalletNode in2Node = chg.get(1);
        WalletNode changeNode = chg.get(2);

        Transaction fundA = fundingTx("fundA-" + variant, new long[] {150000L + variant, 50000L}, new Script[] {in1Node.getOutputScript(), otherScript});
        Transaction fundB = fundingTx("fundB-" + variant, new long[] {1000L, 72000L}, new Script[] {destScript, in2Node.getOutputScript()});

        Date date = new Date(1700000000000L);
        BlockTransaction btA = new BlockTransaction(fundA.getTxId(), 800000, date, 0L, fundA);
        BlockTransaction btB = new BlockTransaction(fundB.getTxId(), 800001, date, 0L, fundB);
        Map<Sha256Hash, BlockTransaction> fundTxs = new HashMap<>();
        fundTxs.put(fundA.getTxId(), btA);
        fundTxs.put(fundB.getTxId(), btB);
        w.updateTransactions(fundTxs);
        BlockTransactionHashIndex hiA = new BlockTransactionHashIndex(fundA.getTxId(), 800000, date, 0L, 0, 150000L + variant);
        BlockTransactionHashIndex hiB = new BlockTransactionHashIndex(fundB.getTxId(), 800001, date, 0L, 1, 72000L);
        in1Node.getTransactionOutputs().add(hiA);
        in2Node.getTransactionOutputs().add(hiB);

        Transaction tx = new Transaction();
        tx.setVersion(2);
        tx.setLocktime(800100 + variant);
        TransactionSignature dummy = TransactionSignature.dummy(st.getSignatureType());
        TransactionInput i1 = st.addSpendingInput(PolicyType.SINGLE_HD, tx, fundA.getOutputs().get(0), ks.getPubKey(in1Node), dummy);
        i1.setSequenceNumber(TransactionInput.SEQUENCE_RBF_ENABLED);
        TransactionInput i2 = st.addSpendingInput(PolicyType.SINGLE_HD, tx, fundB.getOutputs().get(1), ks.getPubKey(in2Node), dummy);
        i2.setSequenceNumber(TransactionInput.SEQUENCE_RBF_ENABLED);

        long fee = 1500;
        long destValue = 180000;
        long changeValue = 150000L + variant + 72000L - destValue - fee;
        TransactionOutput destOut = tx.addOutput(destValue, destScript);
        TransactionOutput changeOut = tx.addOutput(changeValue, changeNode.getOutputScript());

        Payment payment = new Payment(destAddr, "dest", destValue, false);
        List<WalletTransaction.Output> outputs = List.of(new WalletTransaction.PaymentOutput(destOut, payment),
                new WalletTransaction.ChangeOutput(changeOut, changeNode, changeValue));
        Map<BlockTransactionHashIndex, WalletNode> selected = new LinkedHashMap<>();
        selected.put(hiA, in1Node);
        selected.put(hiB, in2Node);
        WalletTransaction wt = new WalletTransaction(w, tx, List.of(), List.of(selected), List.of(payment), outputs, fee);

        PSBT psbt = wt.createPSBT();
        if(unified) {
            for(PSBTInput pi : psbt.getPsbtInputs()) {
                SigHash sh = pi.getSigHash();
                pi.setSigHash(sh == null ? SigHash.UNIFIED_ALL : sh.withUnified());
            }
        }
        Transaction unsigned = new Transaction(psbt.getTransaction().bitcoinSerialize());

        w.sign(psbt);
        w.finalise(psbt);
        Transaction fin = psbt.extractTransaction();

        StringBuilder sb = new StringBuilder();
        sb.append("{\"network\":").append(q(netName));
        sb.append(",\"mnemonic\":").append(q(words));
        sb.append(",\"passphrase\":").append(q(pass));
        sb.append(",\"scriptType\":").append(q(st.name()));
        sb.append(",\"unified\":").append(unified);
        sb.append(",\"variant\":").append(variant);
        sb.append(",\"unsignedTx\":").append(q(hex(unsigned.bitcoinSerialize())));
        sb.append(",\"inputs\":[");
        List<TransactionOutput> spent = new ArrayList<>();
        for(int i = 0; i < unsigned.getInputs().size(); i++) {
            TransactionInput in = unsigned.getInputs().get(i);
            boolean isA = in.getOutpoint().getHash().equals(fundA.getTxId());
            Transaction prev = isA ? fundA : fundB;
            WalletNode node = isA ? in1Node : in2Node;
            TransactionOutput prevOut = prev.getOutputs().get((int)in.getOutpoint().getIndex());
            spent.add(prevOut);
            sb.append(i > 0 ? "," : "");
            sb.append("{\"prevTx\":").append(q(hex(prev.bitcoinSerialize())));
            sb.append(",\"vout\":").append(in.getOutpoint().getIndex());
            sb.append(",\"value\":").append(prevOut.getValue());
            sb.append(",\"scriptPubKey\":").append(q(hex(prevOut.getScriptBytes())));
            sb.append(",\"path\":").append(q(node.getDerivationPath()));
            sb.append("}");
        }
        sb.append("],\"digests\":[");
        for(int i = 0; i < unsigned.getInputs().size(); i++) {
            Sha256Hash d;
            Script spk = spent.get(i).getScript();
            if(st == ScriptType.P2TR) {
                d = unified ? unsigned.hashForUnifiedSignature(spent, i, UnifiedScriptType.TAPROOT, null, SigHash.UNIFIED_ALL.value, null, null, null)
                        : unsigned.hashForTaprootSignature(spent, i, false, null, SigHash.DEFAULT.value, null);
            } else {
                ECKey pub = ECKey.fromPublicOnly(fin.getInputs().get(i).getWitness() != null && fin.getInputs().get(i).hasWitness()
                        ? fin.getInputs().get(i).getWitness().getPushes().get(1)
                        : fin.getInputs().get(i).getScriptSig().getChunks().get(1).data);
                Script scriptCode = ScriptType.P2PKH.getOutputScript(PolicyType.SINGLE_HD, pub);
                if(unified) {
                    d = unsigned.hashForUnifiedSignature(spent, i, st == ScriptType.P2PKH ? UnifiedScriptType.BARE : UnifiedScriptType.WITNESS_V0,
                            scriptCode.getProgram(), SigHash.UNIFIED_ALL.value, null, null, null);
                } else if(st == ScriptType.P2PKH) {
                    d = unsigned.hashForLegacySignature(i, spk, SigHash.ALL);
                } else {
                    d = unsigned.hashForWitnessSignature(i, scriptCode, spent.get(i).getValue(), SigHash.ALL);
                }
            }
            sb.append(i > 0 ? "," : "").append(q(d.toString()));
        }
        sb.append("],\"signedTx\":").append(q(hex(fin.bitcoinSerialize())));
        sb.append(",\"txid\":").append(q(fin.getTxId().toString()));
        sb.append(",\"vsize\":").append(fin.getVirtualSize());
        sb.append("}");
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        //Network can only be set once per JVM, so this runs once per network and the outputs are merged
        String netName = args[0];
        Network network = switch(netName) {
            case "mainnet" -> Network.MAINNET;
            case "testnet4" -> Network.TESTNET4;
            case "regtest" -> Network.REGTEST;
            default -> throw new IllegalArgumentException(netName);
        };
        Network.set(network);
        StringBuilder out = new StringBuilder("{\"wallets\":[");
        boolean first = true;
        String[][] seeds = {{WORDS_12, ""}, {WORDS_24, "shrike passphrase"}};
        Object[][] nets = {{netName, network}};
        for(Object[] net : nets) {
            for(String[] seed : seeds) {
                for(ScriptType st : TYPES) {
                    out.append(first ? "" : ",\n").append(walletJson((String)net[0], seed[0], seed[1], st));
                    first = false;
                }
            }
        }
        out.append("],\n\"signing\":[");
        first = true;
        for(Object[] net : netName.equals("testnet4") ? new Object[][] {} : nets) {
            for(String[] seed : seeds) {
                for(ScriptType st : TYPES) {
                    for(boolean unified : new boolean[] {false, true}) {
                        for(int variant = 0; variant < 2; variant++) {
                            out.append(first ? "" : ",\n").append(signJson((String)net[0], seed[0], seed[1], st, unified, variant));
                            first = false;
                        }
                    }
                }
            }
        }
        out.append("]}\n");
        System.out.print(out);
    }
}
