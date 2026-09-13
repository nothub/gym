// The deployed build id, rewritten by scripts/build.sh on the way into dist/.
//
// It lives in its own file so sw.js is never rewritten by the build. Imported
// scripts are part of the service worker's byte-for-byte update check, so this
// file changing is what makes the browser install a new worker.
//
// "dev" is the honest value for a checkout that was never deployed.
self.BUILD = "dev";
