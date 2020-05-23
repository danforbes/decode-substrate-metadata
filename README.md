# Decode Substrate Metadata

[Substrate](https://www.substrate.io/)-based blockchains use the [SCALE](https://www.substrate.io/kb/advanced/codec)
codec to encode data, including [the metadata](https://www.substrate.io/kb/runtime/metadata) that describes the chain.
The purpose of this project is to learn more about the SCALE codec by using it to decode
[`v11` of Substrate metadata](https://crates.parity.io/frame_metadata/struct.RuntimeMetadataV11.html).

## Usage

In order to use this project, you must first install its dependencies:

```
$ yarn
```

Then, use the provided `start` command to fetch the latest metadata from `wss://kusama-rpc.polkadot.io/` and write the
raw metadata to `metadata.scale` & the parsed metadata to `metadata.json`.

```
$ yarn start
```

## Source

All of the code for this project is in a single file, [`index.js`](./index.js). Take a look and see the SCALE codec in
action :nerd_face:
