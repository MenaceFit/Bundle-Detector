"""Hiérarchie d'exceptions des sources de données.

Elle vit dans ``utils`` et non dans ``providers`` pour que la couche
concurrence puisse en faire partie sans import circulaire — et c'est
important : ``CircuitBreakerOpen`` doit être un ``ProviderError``.

Historiquement il héritait de ``RuntimeError`` en parallèle de
``ProviderError``. Les deux étaient donc des frères, et les vingt-cinq
``except ProviderError`` qui assurent la dégradation gracieuse du moteur le
laissaient passer : un disjoncteur ouvert faisait échouer un scan entier au
lieu de simplement priver le rapport d'une donnée.
"""

from __future__ import annotations


class ProviderError(RuntimeError):
    """Échec récupérable côté source de données (HTTP, RPC, délai dépassé).

    Toute donnée manquante doit se traduire par une baisse de confiance dans
    le rapport, jamais par l'échec du scan.
    """


class RateLimitedError(ProviderError):
    """HTTP 429, ou throttling signalé par le fournisseur.

    Ce n'est pas une panne : c'est de la contre-pression. Le traiter comme une
    panne — en ouvrant un disjoncteur — transforme un ralentissement passager
    en indisponibilité totale.
    """


class CircuitBreakerOpen(ProviderError):
    """Fournisseur temporairement écarté après des échecs répétés."""
