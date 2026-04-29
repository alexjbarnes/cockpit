# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-29

### Fixed
- Production builds now use Webpack instead of Turbopack. Turbopack emitted hashed external references (`shiki-<hash>/wasm`) that Node could not resolve at runtime in installed tarballs, causing syntax highlighting to fail with `Failed to load external module` after `npx @alexjbarnes/cockpit`.

### Security
- Override `@tensorflow/tfjs-node` (an optional transitive of `magika`) with an empty stub to drop a vulnerable `@mapbox/node-pre-gyp` chain. `magika` runs in the browser, so the Node bindings are unused.
- Override `postcss` to `^8.5.12` to clear [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) (line return parsing).

## [0.1.0] - 2026-04-29

Initial release.
