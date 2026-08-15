# Migrations

The schema lives in `app/db/models.py` and is created on startup with
`Base.metadata.create_all` (`app.db.session.init_db`). That is deliberate for
first deployment and for the SQLite default: the tool must run with zero
infrastructure setup.

Once you are running against a PostgreSQL instance whose data you care about,
switch to Alembic so schema changes are reviewable and reversible:

```bash
pip install alembic
alembic init -t async migrations      # writes migrations/env.py + alembic.ini
```

Then point Alembic at the existing metadata by editing `migrations/env.py`:

```python
from app.config import get_settings
from app.db.models import Base

target_metadata = Base.metadata
config.set_main_option("sqlalchemy.url", get_settings().database_url)
```

Baseline an existing database (so the first migration does not try to recreate
tables that already exist), then work normally:

```bash
alembic revision --autogenerate -m "baseline"
alembic stamp head            # existing DB: record the baseline without applying
alembic upgrade head          # new DB: apply
```

## Schema notes

* `wallet_launch_history` and `clusters.fingerprint` carry the **cross-launch
  memory**. Everything else can be rebuilt from chain data by re-scanning;
  these two accumulate the signal that a single scan cannot compute.
* `known_entities` is an *override* layer on top of the bundled registry in
  `app/data/known_entities.json`. Rows added here take effect without a code
  change — the intended way to correct or extend exchange labels.
* Indexes are declared on every column the repository filters by (mint, wallet,
  creator, source, created_at). Add one whenever you add a query.
* The database is optional by design: every read helper returns empty and every
  write is best-effort, so an unavailable database costs the cross-launch
  signal and nothing else.
