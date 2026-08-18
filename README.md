# Prix App Store par pouvoir d'achat

Skill [Claude Code](https://claude.com/claude-code) + outil en ligne de commande pour
adapter les prix d'abonnement iOS au pouvoir d'achat réel de chaque pays.

## Le problème

Apple convertit déjà votre prix dans les 175 territoires, mais **au taux de change**. Un
abonnement à 49,99 €/an ressort donc autour de 45 $ au Maroc, au Sénégal ou en Côte
d'Ivoire — plusieurs fois ce qu'un abonnement numérique se vend réellement là-bas. Spotify
Premium y est à 3,29 $/mois quand la France paie 12,14 €.

Vous ne le voyez jamais depuis votre pays. Vos campagnes dans ces marchés convertissent
mal, et vous concluez que le marché ne vaut rien — alors que c'est le prix qui est hors
de portée.

Le calcul inverse est vrai aussi : la Suisse, les États-Unis ou Singapour supportent un
prix plus élevé que le vôtre, et l'auto-conversion d'Apple laisse cet argent sur la table.

## Comment ça marche

Quatre étapes, aucune saisie manuelle de taux de change.

**1. Un indice de pouvoir d'achat par pays.** Construit depuis l'API publique de la Banque
mondiale (gratuite, sans clé) :

```
indice = √( (RNB/hab PPP × part du revenu des 10 % les plus riches) / idem pays de référence )
```

- Le **RNB par habitant en PPP** mesure le pouvoir d'achat réel, pas le taux de change.
- La **part du décile supérieur** corrige le biais central : votre acheteur n'est pas
  l'habitant moyen. Posséder un iPhone place déjà dans le haut de la distribution.
- La **racine carrée** amortit ce qu'il reste. Cette population consomme largement importé,
  donc à des prix mondiaux.

Sans ces deux corrections, le calcul brut donne 8,40 € pour le Maroc et 3,92 € pour le
Sénégal : des chiffres exacts et commercialement inexploitables.

**2. Une base de conversion signée Apple.** Plutôt que de manipuler 43 devises et leurs
taux, l'outil demande à Apple l'`equalization` de votre prix de référence : le prix
équivalent qu'Apple mettrait lui-même dans chaque territoire, taxes locales et arrondi
psychologique compris. L'indice s'applique sur cette base.

**3. Un vrai point de prix.** Apple n'accepte que ~800 valeurs par territoire. L'outil
choisit la plus proche de la cible, avec une préférence pour celles qui ressemblent à un
prix : `19,99` l'emporte sur `20,14` à distance comparable, et `26 900 ₦` sur `27 013 ₦`.

**4. L'écriture, après simulation.** `plan` n'écrit jamais rien et sort le tableau complet
avant/après. `apply` pousse les prix, avec reprise sur les erreurs transitoires de l'API.

Exemple réel, prix de référence 49,99 € :

| Territoire | Avant (auto Apple) | Après | Indice |
|---|---|---|---|
| États-Unis | 44,99 $ | 57,99 $ | 1,30 |
| Suisse | 45 CHF | 51,90 CHF | 1,29 |
| Maroc | 44,99 $ | 20,99 $ | 0,47 |
| Côte d'Ivoire | 49,99 $ | 17,99 $ | 0,36 |
| Sénégal | 49,99 $ | 14,99 $ | 0,30 |
| Inde | 4 999 ₹ | 1 999 ₹ | 0,40 |
| Nigeria | 69 900 ₦ | 26 900 ₦ | 0,39 |

## Installation

### Comme skill Claude Code

```bash
git clone https://github.com/harryjmg/appstore-ppp-pricing.git \
  ~/.claude/skills/appstore-ppp-pricing
```

Puis, dans Claude Code : `/appstore-ppp-pricing`, ou simplement « adapte mes prix App Store
au pouvoir d'achat de chaque pays ». Claude vous fait trancher les décisions qui comptent
avant de lancer quoi que ce soit.

### En ligne de commande

```bash
cd scripts
node ppp_pricing.js produits                              # lister vos abonnements
node ppp_pricing.js init --produits=<id>,<id> --ref=FRA   # construire la config
node ppp_pricing.js plan                                  # simuler — n'écrit rien
node ppp_pricing.js apply                                 # écrire
```

## Prérequis

- **Node.js.** Aucune dépendance npm : le JWT ES256 est signé avec le module `crypto`
  natif.
- **Une clé App Store Connect API de rôle App Manager ou Admin**
  (App Store Connect → Users and Access → Integrations). Une clé de reporting lit les prix
  mais reçoit un 403 à l'écriture.

Créez `scripts/asc_api_config.json`, avec le `.p8` dans le même dossier :

```json
{
  "key_id": "XXXXXXXXXX",
  "issuer_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "key_file": "AuthKey_XXXXXXXXXX.p8",
  "app_id": "1234567890"
}
```

Le `.gitignore` bloque la clé et la config. Vérifiez-le avant de pousser.

## Les décisions qui déterminent le résultat

Le code est la partie facile. [`SKILL.md`](SKILL.md) détaille les six arbitrages :

1. **Est-ce que ça vaut le coup pour vous.** Si un pays fait 90 % de vos installs, c'est le
   prérequis d'une ouverture de marché, pas un gain immédiat. Le savoir évite de juger au
   mauvais indicateur.
2. **Quels produits traiter.** Les prix sont attachés aux produits, pas à l'app. Ne baisser
   que l'offre principale rend vos offres de rétention plus chères que celle qu'on vient
   de refuser.
3. **Jusqu'où descendre.** Où poser le plancher, et comment l'étalonner sur un comparable
   réel plutôt que sur la théorie.
4. **Faut-il monter** là où le pouvoir d'achat dépasse le vôtre. La plupart n'osent pas.
5. **Vos abonnés actuels.** Un booléen de l'API les protège intégralement — inutile de
   créer de nouveaux produits, ce qui est le réflexe courant et coûteux.
6. **L'entretien.** Dès qu'un prix est fixé à la main, Apple cesse d'ajuster ce territoire.

## Trois pièges de l'API App Store Connect

Non documentés, déjà gérés — utiles si vous écrivez votre propre version.

- **`SubscriptionPriceCreateRequest` a trois attributs et les trois comptent.** `planType`
  (sinon un produit à plusieurs plans reçoit son prix sur le mauvais), `preserveCurrentPrice`,
  et `startDate` — obligatoire, et **au minimum J+1** : à `null` Apple comprend « prix
  initial » et refuse tout produit déjà approuvé (`STATE_ERROR`), au jour même il refuse
  aussi (`ENTITY_ERROR`).
- **L'index de prix Apple est global.** Le champ `p` de l'ID base64 d'un price point ne
  dépend pas de l'abonnement : l'ID se forge pour n'importe quel produit. Une grille de
  territoire chargée une fois sert donc pour tous vos produits, au lieu de 800 points ×
  175 territoires × N produits.
- **Un produit à deux plans de paiement impose une cohérence entre eux.** Annuel payé
  d'avance + annuel payable au mois : Apple refuse tout écrit qui laisserait le produit
  dans un état intermédiaire (`INVALID_PRICE_TOO_HIGH` / `TOO_LOW`), quel que soit l'ordre.
  Il faut les écrire ensemble via `PATCH /v1/subscriptions/{id}` — et vérifier d'abord sur
  un produit non vendu que ce PATCH ajoute les prix au lieu de remplacer toute la grille.

## Licence

MIT. Aucune garantie : `plan` avant `apply`, et relisez le tableau.
