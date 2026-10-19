# Reference vectors from Shrike's own library

`VectorGen.java` drives Shrike's drongo library (the Java protocol code inside the desktop app) to produce
`tests/vectors/drongo-vectors.json`: account keys, descriptors in Cormorant's form, addresses, and fully signed
transactions for all four address types, with and without the unified signature hash.

To regenerate, build drongo from the Shrike source (`git clone --recursive https://github.com/privkeyio/shrike.git`),
then compile and run this file against drongo's classes once per network (drongo only lets a JVM pick one):

```sh
javac -cp drongo/build/classes/java/main:<drongo dependencies> -d out VectorGen.java
java -cp out:drongo/build/classes/java/main:<drongo dependencies> VectorGen mainnet > vectors-mainnet.json
java ... VectorGen testnet4 > vectors-testnet4.json
java ... VectorGen regtest > vectors-regtest.json
```

and merge the three files' `wallets` and `signing` arrays into one JSON object.
