/**
 * The app is bundled into dist/ and explicitly ships runtime binaries via
 * resources/ and vendor/. Returning false tells electron-builder not to collect
 * node_modules from the Bun workspace.
 */
module.exports = async function beforeBuild() {
  return false;
};
