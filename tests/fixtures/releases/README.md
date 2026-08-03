# Release fixtures

Installer tests generate deterministic release archives and manifests in temporary directories from
small runtime trees. Keeping the archives generated avoids committing platform-specific binaries
while exercising the same archive and manifest code used by release builds.
