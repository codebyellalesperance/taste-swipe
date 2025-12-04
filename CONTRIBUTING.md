# contributing

thanks for your interest in contributing to eras wrapped!

## development setup

1. **fork and clone** the repository.
2. **backend setup**:
   ```bash
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. **frontend setup**:
   ```bash
   cd frontend
   # no build steps required for now, just serve static files
   python3 -m http.server 8000
   ```
4. **environment variables**:
   copy `.env.example` to `.env` and fill in your spotify/openai credentials.

## code style

- **python**: follow pep 8. use `black` for formatting.
- **javascript**: use standard js style.
- **commits**: use conventional commits (e.g., `feat: add new era detection`).

## testing

ensure all tests pass before submitting a pr:

```bash
# backend
cd backend
pytest

# frontend
cd frontend
npm test
```

## pull requests

1. create a new branch for your feature.
2. keep changes focused and minimal.
3. include tests for new functionality.
4. update documentation if needed.
