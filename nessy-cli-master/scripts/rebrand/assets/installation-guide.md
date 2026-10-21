# Install this Nessy build

Use Node.js 22 or newer. Download `nestor-nessy-cli-0.19.1.tgz` from the
rebrand pipeline artifacts and install it locally:

```sh
npm install --global ./nestor-nessy-cli-0.19.1.tgz
nessy --version
```

For removal, run `npm uninstall --global @nestor/nessy-cli`.

Hosted installers and automatic updates are disabled until a Nessy distribution
channel for this build is configured. The installation entrypoints fail with an
explanation and do not download another product. Existing local standalone
uninstall scripts are retained for locally built standalone packages.
