# Browser-test tooling. Nothing here reaches the shipped app, which stays
# dependency-free -- Playwright and its browsers live only in this image.
#
# The image ships the browser binaries one Playwright release expects, so the
# image tag and the npm package must be the same version. Declaring it once and
# deriving both leaves nothing for Renovate to update by half: its dockerfile
# manager expands ARG directives, so bumping this line moves the package too.
ARG PLAYWRIGHT_VERSION=1.63.0

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# ARGs declared before FROM do not survive it; re-declaring imports the value.
ARG PLAYWRIGHT_VERSION

# node_modules deliberately sits one level above the mount point. Node resolves
# it by walking up from /work/app/test, so nothing is ever written into the
# repository and it can be mounted read-only.
WORKDIR /work
RUN npm install --no-audit --no-fund "@playwright/test@${PLAYWRIGHT_VERSION}"

WORKDIR /work/app
