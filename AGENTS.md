# Build delivery

After every successful Chrome production build, refresh the unpacked extension in `~/Downloads/UUGet/`. Reuse this fixed directory so Chrome can reload the existing installation.

Use the build scripts in `package.json`, which synchronize the artifact automatically. When invoking WXT directly, run `pnpm sync:chrome-artifact` after the successful build and before handing it off.

Delivery is complete when the destination manifest and file contents match the current `.output/chrome-mv3/` artifact. Report the version from the built manifest.
