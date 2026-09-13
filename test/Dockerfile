# Browser-test tooling. Nothing here reaches the shipped app, which stays
# dependency-free -- Playwright and its browsers live only in this image.
#
# Keep the tag in step with the @playwright/test version below: the image
# ships the browser binaries a given Playwright release expects.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# node_modules deliberately sits one level above the mount point. Node resolves
# it by walking up from /work/app/test, so nothing is ever written into the
# repository and it can be mounted read-only.
WORKDIR /work
RUN npm install --no-audit --no-fund @playwright/test@1.63.0

WORKDIR /work/app
