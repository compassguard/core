# Public Mintlify docs

This folder contains the public, shareable Compass Guard docs served by Mintlify. Internal product/spec docs stay in `docs/`.

## Local preview

Run from the repository root:

```sh
npx mint dev
```

Mintlify reads `docs.json` and the pages under `public-docs/`.

## Publish

Connect this GitHub repo to Mintlify, set the docs root to the repository root, and attach the custom domain:

```text
docs.compassguard.xyz
```

DNS and Mintlify project setup are intentionally not configured in this repo.
