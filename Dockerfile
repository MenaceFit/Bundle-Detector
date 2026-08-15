FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    MPLBACKEND=Agg

WORKDIR /app

# Build tooling is needed for a few wheels; it is dropped from the final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential

COPY app ./app
COPY scripts ./scripts
COPY pyproject.toml README.md ./

# The bot is read-only and needs no privileges.
RUN useradd --create-home --uid 10001 pfbd \
    && mkdir -p /app/exports \
    && chown -R pfbd:pfbd /app
USER pfbd

# The API exposes /health; the bot has no listener, so compose overrides this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["python", "-m", "app.main", "bot"]
