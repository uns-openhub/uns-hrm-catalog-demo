# Project guidance

This repository is a small, public UNS Kit Data Catalog example. Keep the data
source fixed to the fictional `rtt-demo-app` furnace zone 1 temperature topic.
Do not add customer topics, local `config.json`, `.env`, tokens, or controller
runtime files to Git.

The JSON operation is a bounded browser preview. CSV and Parquet file exports
must either contain the complete requested range or fail explicitly. Read
history using the caller's bearer token, keep the JWKS check, and preserve
bounded memory while preparing Parquet files. Run `pnpm run verify` before
publishing changes.
