# Repository guidance

- Do not manually change cache-busting query parameters when editing frontend assets.
- `pipeline/build_library.py` automatically generates content-version query parameters for CSS, JavaScript, and JavaScript module imports during the build. Rely on that build step for cache invalidation.
- For local browser or device-simulator development, run `npm run dev`; it refreshes the generated content versions before serving and disables caching for editable frontend assets.
- The repository has a populated Python virtual environment at `.venv`. Use `.venv/bin/python` for Python commands instead of the system `python` or `python3`; required packages such as `requests` and `pymupdf` are installed there.
- Run the pipeline unit tests from the repository root with `.venv/bin/python -m unittest discover -s pipeline -p 'test_*.py'`. Check and use `.venv` before concluding that Python dependencies are unavailable.
