# Repository guidance

- Do not manually change cache-busting query parameters when editing frontend assets.
- `pipeline/build_library.py` automatically generates content-version query parameters for CSS, JavaScript, and JavaScript module imports during the build. Rely on that build step for cache invalidation.
