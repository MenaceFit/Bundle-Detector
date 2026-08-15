"""Scoring engine.

Analyzers measure; this package decides.  The rules it enforces:

* every score is a weighted sum of *bounded* signal contributions;
* no single signal can reach a high verdict on its own (§17, §46);
* every point is attributable to a named contribution (§85);
* missing data lowers confidence instead of being assumed away (§48, §86).
"""
