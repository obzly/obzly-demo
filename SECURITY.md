# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: this repository's **Security** tab →
**Report a vulnerability**. Don't open a public issue or pull request for a security problem. For
a problem in Obzly itself (the server or its web UI), report it on
[obzly/obzly](https://github.com/obzly/obzly/security) instead.

We aim to acknowledge a report within three working days.

## Scope

The demo at [demo.obzly.com](https://demo.obzly.com) is a static site: it has no server, accounts
or real data. Everything a visitor does is answered in their own browser from generated sample
data and kept in that browser's localStorage. In scope: anything in this repository that could
harm a visitor, such as script injection through the demo's handlers or sample data, the demo
sending data anywhere, or the build and deploy workflows publishing something other than this
repository's code.
