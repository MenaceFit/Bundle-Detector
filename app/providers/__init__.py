"""Data providers.

The scoring engine never imports a concrete provider: it talks to
:class:`app.providers.registry.ProviderHub`, which owns failover between
Solana RPC, Helius and Solscan and reports what actually answered so the
confidence engine can discount partial data.
"""
