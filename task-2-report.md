# Task 2: Dockerfile — Americana toolchain

## Summary

Added the Americana toolchain (imposm3, martin, Node.js 22 + Puppeteer/Chromium
system libs, pre-generated OpenMapTiles build artifacts, pre-built
`browser-bundle.js`) to the render image per the plan. Two real build/runtime
bugs were found and fixed along the way (both diagnosed from actual build/run
output, not guessed):

1. `npm install -g carto@1.2.0` failed with `npm: not found` — the NodeSource
   Node.js install silently deleted npm/node from the image via
   `apt-get autoremove`.
2. `imposm version` and `martin --version` failed at runtime with
   `error while loading shared libraries` — two missing runtime libraries
   that the image never installed.

## Root cause 1: npm disappearing after the Node.js install step

**Diagnosis.** The original apt-get block (now `Dockerfile` line ~28-41)
installed Debian's `npm` package (not `nodejs`). Debian's `npm` depends on
Debian's `nodejs`, so that first `apt-get install ... npm` pulled in Debian's
`nodejs` too, as an **automatically-installed** dependency — confirmed in the
failing build's log (`/tmp/americana_build.log`):

```
#17 22.68 The following packages will be upgraded:
#17 22.68   nodejs
```

("upgraded", not "newly installed" — proving a `nodejs` package already
existed before the NodeSource step ran.)

When the later `RUN curl ... setup_22.x | bash - && apt-get install nodejs`
step ran, apt treated NodeSource's `nodejs` as an **upgrade of that same
package name**, so it inherited the pre-existing "automatically installed"
flag. Installing it also removed Debian's `npm` (package conflict):

```
#17 27.67 Removing npm (9.2.0~ds1-3) ...
```

With `npm` gone, nothing depended on `nodejs` anymore, so apt now considered
it "automatically installed and no longer required":

```
#17 36.40 The following packages were automatically installed and are no longer required:
#17 36.40   ... nodejs
```

The same RUN line's trailing `apt-get autoremove --yes` then deleted `nodejs`
itself before the layer even finished:

```
#17 69.54 Removing nodejs (22.23.2-1nodesource1) ...
```

Net effect: node and npm were both gone by the time
`RUN npm install -g carto@1.2.0` ran two steps later, hence `npm: not found`.

**Fix.** Removed `npm` from the original, earlier apt-get package list
(Dockerfile line ~42, now deleted) so Debian's `npm`/`nodejs` pair is never
installed in the first place. Nothing between that block and the NodeSource
step needs npm (only imposm/martin binary COPYs happen in between). With
`npm` never installed, the later `apt-get install nodejs` is a **fresh,
explicit install**, which apt marks manual — so the trailing
`apt-get autoremove --yes` in that same RUN line correctly leaves it alone.

**Verification.** Added a temporary diagnostic RUN right after the Node.js
install step (`RUN which npm; which node; dpkg -l | grep -E 'npm|nodejs'`),
rebuilt, and confirmed:

```
#18 [development_build  7/21] RUN which npm; which node; dpkg -l | grep -E 'npm|nodejs' || true
#18 0.110 /usr/bin/npm
#18 0.123 /usr/bin/node
#18 0.170 ii  nodejs   22.23.2-1nodesource1   amd64   Node.js event-based server-side javascript engine
```

Only one `nodejs`/`npm` install now exists, and the apt-get autoremove step
in that same layer reported "0 to remove and 10 not upgraded" — no longer
removing anything. The diagnostic line was removed before the final commit.

## Root cause 2: imposm3/martin missing shared libraries at runtime

Not part of the original bug report, but found while running Step 4's
smoke tests against the (by-then fixed) image — the build succeeded, but two
of the five smoke-test commands failed at runtime:

```
$ docker run --rm --platform linux/amd64 before_after_americana_test imposm version
imposm: error while loading shared libraries: libleveldb.so.1d: cannot open shared object file: No such file or directory

$ docker run --rm --platform linux/amd64 before_after_americana_test martin --version
martin: error while loading shared libraries: libuv.so.1: cannot open shared object file: No such file or directory
```

`imposm` and `martin` are `COPY --from=...`'d in from two different upstream
images (`openmaptiles/openmaptiles-tools:7.2` and
`ghcr.io/maplibre/martin:1.13.0`) — only the binaries are copied, not their
shared-library dependencies, and this postgis-based Debian trixie image
never installed the two libraries they need.

Confirmed with `ldd` against `martin` (imposm's `ldd` segfaulted, but the
direct run error was already unambiguous) and `apt-cache policy` inside the
image:

```
libuv.so.1 => not found
...
$ apt-cache policy libuv1t64 libleveldb1d
libuv1t64:
  Candidate: 1.50.0-2
libleveldb1d:
  Candidate: 1.23-5+b2
```

Note `libuv1t64`, not `libuv1` — trixie's 64-bit-time_t package-name
transition (the same phenomenon already called out in the Dockerfile's
existing comment about `libasound2`/`libasound2t64`) means there is no plain
`libuv1` package to install; `apt-cache policy libuv1` shows no candidate.

**Fix.** Added `libleveldb1d` and `libuv1t64` to the same apt-get install
list that adds the Puppeteer/Chromium system libraries, and documented why
in a Dockerfile comment.

**Verification.** After the fix, both binaries run cleanly (see full smoke
test output below).

## Full successful build output (final Dockerfile, no diagnostic line)

```
$ docker build --platform linux/amd64 -t before_after_americana_test .
...
#20 [development_build  9/20] RUN npm install -g carto@1.2.0
#20 5.933
#20 5.933 added 64 packages in 5s
#20 DONE 6.0s

#21 [development_build 10/20] COPY . /home/postgres
#21 DONE 0.4s

#22 [development_build 11/20] COPY --from=openmaptiles_build /build /home/postgres/render/americana/openmaptiles-build
#22 DONE 0.0s

#23 [development_build 12/20] RUN cd /home/postgres/render/americana && npm ci && npm run build
#23 21.53
#23 21.53 added 159 packages, and audited 160 packages in 21s
#23 22.76
#23 22.76 > build
#23 22.76 > esbuild browser-entry.js --bundle --format=iife --outfile=dist/browser-bundle.js
#23 23.30
#23 23.30   dist/browser-bundle.js  1.6mb
#23 23.30
#23 23.30 Done in 465ms
#23 DONE 23.4s

#24 [development_build 13/20] RUN usermod -u 1000 postgres
#24 DONE 0.1s
#25 [development_build 14/20] RUN chown -R 1000 /home/postgres
#25 DONE 4.8s
#26 [development_build 15/20] RUN mkdir -p /home/postgres/openstreetmap-carto/data
#26 DONE 0.1s
#27 [development_build 16/20] RUN mkdir -p /home/postgres/output
#27 DONE 0.1s
#28 [development_build 17/20] RUN mkdir -p /home/postgres/pgdata
#28 DONE 0.1s
#29 [development_build 18/20] WORKDIR /home/postgres
#29 DONE 0.0s
#30 [development_build 19/20] RUN git clone https://github.com/geofabrik/sendfile_osm_oauth_protector
#30 DONE 0.8s
#31 [development_build 20/20] RUN chmod +x /home/postgres/render/entrypoint.sh /home/postgres/render/render_job.py
#31 DONE 0.1s

#32 exporting to image
#32 exporting layers 18.7s done
#32 naming to docker.io/library/before_after_americana_test:latest done
#32 DONE 18.7s
```

Note: `docker build` (no `--platform`) fails on this machine with
`no match for platform in manifest: not found` because `postgis/postgis`
has no arm64 image — this is a pre-existing, known constraint of this
image, not something introduced here. `--platform linux/amd64` is required
on Apple Silicon.

## Step 4 smoke tests — full output

```
$ docker run --rm --platform linux/amd64 before_after_americana_test imposm version
... (postgres bootstrap log, harmless — the entrypoint always inits pgdata) ...
0.11.1

$ docker run --rm --platform linux/amd64 before_after_americana_test martin --version
... (postgres bootstrap log) ...
martin 1.13.0

$ docker run --rm --platform linux/amd64 before_after_americana_test node -e "require('puppeteer'); console.log('puppeteer OK')"
... (postgres bootstrap log) ...
node:internal/modules/cjs/loader:1433
  throw err;
Error: Cannot find module 'puppeteer'
Require stack:
- /home/postgres/[eval]
```

The last one "fails" as literally written in the plan, but this is a test
invocation issue, not a Dockerfile defect: `puppeteer` was installed by
`npm ci` inside `${HOME}/render/americana/` (a Node project with its own
`package.json`/`node_modules`), and the default container `WORKDIR` is
`${HOME}` (`/home/postgres`) — Node's module resolution only walks up from
the process's cwd, so it never finds
`/home/postgres/render/americana/node_modules` from `/home/postgres`.
Confirmed by re-running from the correct cwd:

```
$ docker run --rm --platform linux/amd64 -w /home/postgres/render/americana \
    --entrypoint node before_after_americana_test \
    -e "require('puppeteer'); console.log('puppeteer OK')"
puppeteer OK
```

(`--entrypoint node` was needed alongside `-w` because the image's default
`ENTRYPOINT ["./entrypoint-new.sh"]` is a relative path that no longer
resolves once `-w` changes the working directory.) This matches how Task 3's
`capture.mjs` will actually be invoked (from within `render/americana/`), so
no Dockerfile change was needed here — noting it in case Task 3's wiring
assumes otherwise.

```
$ docker run --rm --platform linux/amd64 before_after_americana_test \
    ls /home/postgres/render/americana/dist/browser-bundle.js
... (postgres bootstrap log) ...
/home/postgres/render/americana/dist/browser-bundle.js

$ docker run --rm --platform linux/amd64 before_after_americana_test \
    ls /home/postgres/render/americana/openmaptiles-build/mapping.yaml
... (postgres bootstrap log) ...
/home/postgres/render/americana/openmaptiles-build/mapping.yaml
```

All five smoke-test checks pass (imposm, martin, puppeteer — with the cwd
correction above — browser-bundle.js, mapping.yaml).

## Files changed

- `Dockerfile`:
  - Removed `npm` from the original apt-get package list (root cause 1 fix).
  - Added `libleveldb1d` and `libuv1t64` to the Node.js/Puppeteer apt-get
    block (root cause 2 fix).
  - Added explanatory comments for both.
