# Obzly live demo

**[demo.obzly.com](https://demo.obzly.com)** runs the real [Obzly](https://github.com/obzly/obzly)
UI in your browser, with sample data and no server. Anything you create or change stays in your
browser; "Reset demo" puts it back.

This repository holds only the demo. The app is the unchanged Obzly frontend from the latest
release: the build checks out [obzly/obzly](https://github.com/obzly/obzly) at that tag, adds this
repository's `src/` as `frontend/src/demo`, and starts the app from `src/entry.ts` instead of
`main.tsx`.

## How it works

- `src/install.ts` replaces `window.fetch` before the app loads and answers every `/api/v1` call
  (and a control plane's `/sites/<id>/api/v1` calls) from `src/handlers/`. Anything else, such as
  the app's own assets, goes to the network as usual.
- The sample data is a fictional online shop, Harborline (`src/world.ts`). Logs, traces and
  metrics are generated from the time range with a seeded random generator, so any range shows
  consistent data. A payments incident recurs every six hours.
- What a visitor creates or changes is saved in their browser's localStorage (`obzly_demo_v1`).
  Nothing is sent anywhere.
- SQL mode runs a real DuckDB (WebAssembly, downloaded the first time it's used). PromQL is a
  built-in subset (`src/query/`).
- Visitors start on the app's real sign-in page. `src/signInPrefill.ts` fills in the demo account
  with a random password, then a random code on the two-factor step; any password and any
  6-digit code work. Signing out goes back there.
- SSO, sending email and cloud credential tests answer "not available in the demo".

All names, hosts and addresses in the sample data are fictional (`*.example.com`, documentation IP
ranges).

## Run it locally

You need Node.js and a checkout of Obzly next to this one:

```bash
git clone https://github.com/obzly/obzly.git ../obzly
```

```bash
(cd ../obzly/frontend && npm ci)
```

```bash
scripts/dev.sh ../obzly
```

`dev.sh` links `src/` into the checkout, so edits here reload in the browser. It also copies
`build/vite.demo.config.ts` and `build/.env.demo` into `frontend/` and installs DuckDB there
without adding it to `package.json`. These show up as untracked files in the Obzly checkout.

Before opening a pull request:

```bash
scripts/check.sh ../obzly
```

It type checks, lints and tests the demo with the app's own settings. `scripts/build.sh ../obzly`
builds the site into `../obzly/frontend/dist`.

## Keeping up with Obzly

- `src/coverage.test.ts` reads every API URL in the app's `entity/*/api` modules and fails when the
  demo doesn't answer one. When Obzly adds an API call, add a handler in `src/handlers/<area>.ts`,
  or a `notInDemo()` stub.
- The **Check** workflow runs on every pull request and daily, against both the latest Obzly
  release and Obzly's main branch. A failed daily run opens an issue, so a breaking UI change is
  found before it is released.
- The **Deploy** workflow publishes to GitHub Pages on every push to main, and daily when there is
  a new Obzly release.

## License

[Apache License 2.0](LICENSE), like Obzly.
