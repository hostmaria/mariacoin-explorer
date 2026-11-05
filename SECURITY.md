# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you found, how to reproduce it, the affected commit or release ID, and the impact you expect. We will acknowledge the report, keep you informed while we investigate, and credit you when a fix is published, unless you prefer not to be named.

## Scope

In scope:

- The explorer application in this repository, including the address claim flow (`lib/claim.js`, `/claim` routes).
- The deployment kit in `deploy/` (host hardening, service units, backup and restore scripts, release builder).
- The public explorer at https://explorer.mariacoin.com.

Out of scope:

- The Maria Core node software. Report those issues to https://github.com/hostmaria/mariacoin.
- Upstream eIquidus issues that are not specific to this fork. Please also report those upstream to https://github.com/team-exor/eiquidus.
- Denial-of-service through sheer traffic volume, social engineering, and findings that need physical or administrator access to a server.

## For users

The explorer will never ask for your private key, seed phrase or wallet password. The address claim page asks only for a public address and a signature over a message issued by the server. Always check that you are on the official explorer hostname before you sign anything.
