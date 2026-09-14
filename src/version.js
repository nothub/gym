// The deployed build id, rewritten by scripts/build.sh on the way into dist/.
//
// Its own file because imported scripts are inside the service worker's
// byte-for-byte update check: this file changing is what makes the browser
// install a new worker, so sw.js never has to be rewritten. The page loads it
// too, hence self, which is the window in a page and the global in a worker.
//
// "dev" is the honest value for a checkout that was never deployed.
self.BUILD = "dev";
