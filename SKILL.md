---
name: appstore-ppp-pricing
description: Adapter les prix d'abonnement App Store au pouvoir d'achat de chaque pays. Guide les décisions (jusqu'où baisser, faut-il monter, qui est impacté) puis applique les prix via l'API App Store Connect. À utiliser quand quelqu'un veut du pricing régional, du PPP, des prix par pays, ou trouve que son prix est hors de portée dans certains marchés.
---

# Prix App Store par pouvoir d'achat

Apple convertit déjà votre prix dans les 175 territoires — mais au taux de change. Résultat :
un abonnement à 49,99 € reste à ~45 $ au Maroc ou au Sénégal, soit plusieurs fois ce que
la population solvable de ces pays paie pour un abonnement numérique. Ce skill remplace la
conversion par un multiplicateur de pouvoir d'achat, pays par pays.

Le code est dans `scripts/ppp_pricing.js` (zéro dépendance npm). Ce qui suit, ce sont les
**décisions à prendre** — c'est là que se joue le résultat, pas dans la plomberie.

---

## Décision 0 — Est-ce que ça vaut le coup pour vous ?

**À trancher en premier, avec les chiffres sous les yeux.** Sortez votre répartition
d'installs par pays sur 30 jours (App Store Connect → Sales and Trends, ou le rapport
SALES de l'API, colonne `Country Code`).

- Si un seul pays fait plus de 90 % de vos installs, le pricing PPP ne va **rien** vous
  rapporter à court terme. Ce n'est pas une optimisation de revenu, c'est le **prérequis
  d'une ouverture de marché** : le prix doit être en place avant de dépenser un euro
  d'acquisition là-bas, sinon vous testerez un marché avec un prix hors de portée et vous
  conclurez à tort qu'il ne convertit pas.
- Si vous avez déjà du trafic international significatif, c'est une optimisation directe
  et vous verrez l'effet en quelques semaines.

Dans les deux cas ça vaut le coup de le faire — mais pas d'en attendre la même chose.
Décidez maintenant ce que vous mesurerez, sinon vous jugerez au mauvais indicateur.

---

## Décision 1 — Votre territoire de référence

Le pays dont le prix ne bougera jamais et sur lequel tous les autres sont indexés. En
général votre marché principal. Tout le reste en découle, y compris les hausses.

Attention si votre marché principal est dans la zone euro : vos voisins partagent votre
devise et votre langue publicitaire. Un utilisateur belge ou luxembourgeois peut comparer.

---

## Décision 2 — Quels produits traiter

**Le piège le plus courant.** Les prix sont attachés à un produit, pas à une app. Si vous
faites des tests de prix, vous avez sans doute une dizaine de produits en base dont deux ou
trois sont réellement servis par votre paywall.

- **Ne traitez que les produits réellement vendus.** `node ppp_pricing.js produits` les
  liste ; croisez avec ce que votre paywall sert vraiment (vos offerings RevenueCat /
  Adapty / Superwall, ou votre code si vous appelez StoreKit en direct).
- **Traitez-les tous, pas seulement le principal.** Si vous avez une offre de rétention,
  une offre winback ou une offre soldée, et que vous ne baissez que l'offre principale,
  vos offres secondaires deviennent *plus chères* que celle qu'on vient de refuser. C'est
  le genre d'incohérence qu'on ne voit jamais depuis son propre pays.
- **Notez-le quelque part** : chaque nouveau produit créé pour un test de prix repart avec
  la conversion automatique d'Apple. Il faut relancer le script après chaque création,
  sinon votre pricing régional disparaît du paywall sans le moindre signal.

---

## Décision 3 — Jusqu'où descendre (le plancher)

Le calcul brut de pouvoir d'achat donne des chiffres justes et **inexploitables** : à part
de revenu constante, un abonnement à 49,99 € en France vaut 8,40 € au Maroc et 3,92 € au
Sénégal. Personne ne vend à ce prix-là, pour trois raisons :

1. votre acheteur n'est pas l'habitant moyen — posséder un iPhone dans ces pays place déjà
   dans le haut de la distribution ;
2. sous un certain seuil vous ouvrez l'arbitrage par VPN et abîmez votre positionnement ;
3. le marché réel est plus haut que le PPP : Spotify facture ~3,29 $/mois en Afrique de
   l'Ouest, très au-dessus de ce que le pouvoir d'achat moyen justifierait.

**Le plancher par défaut est 0,30** (30 % du prix de référence). C'est un choix, pas une
loi. Descendre à 0,20 si votre coût marginal est nul et que vous visez le volume ; remonter
à 0,40 si votre marque est premium.

**Étalonnez sur un vrai comparable** avant de valider : allez voir le prix local de Spotify
ou Netflix dans deux ou trois de vos pays cibles (`spotify.com/<code pays>/premium/`). Si
votre prix cible est très au-dessus, vous êtes hors marché ; très en dessous, vous laissez
de l'argent.

---

## Décision 4 — Monter là où le pouvoir d'achat est supérieur

Le calcul est symétrique : la Suisse, les États-Unis, le Luxembourg, l'Irlande ou Singapour
ressortent au-dessus de la France. **Beaucoup de développeurs n'appliquent que les baisses,
par prudence — et laissent l'argent sur la table.**

Décidez explicitement. Deux garde-fous :

- **La concurrence locale prime sur le calcul.** Au-dessus de 1, ce n'est plus le pouvoir
  d'achat qui contraint mais ce que font vos concurrents sur ce marché. Vérifiez avant
  d'appliquer un +30 % sur un marché disputé.
- **Le plafond par défaut est 1,30.** Au-delà, vous sortez des prix psychologiques usuels
  et vous vous exposez à la comparaison entre marchés voisins.

Et surtout : une hausse ne touchera **personne** parmi vos abonnés actuels (décision 5).

---

## Décision 5 — Vos abonnés actuels

C'est la question qui inquiète tout le monde, et elle a une réponse propre : l'attribut
`preserveCurrentPrice` de l'API.

- **`true`** (défaut du script) — les abonnés existants restent sur leur prix, hausses
  comme baisses. Seuls les nouveaux achats prennent le nouveau prix.
- **`false`** — une baisse profite à tout le monde au renouvellement suivant ; une hausse
  exige le consentement explicite de chaque abonné, et son abonnement expire s'il ne
  répond pas.

**Ne créez pas de nouveaux produits pour ça.** C'est le réflexe courant et c'est une
mauvaise idée : il en faudrait un par offre, à rebrancher dans votre outil de paywall, et
vos séries analytiques par produit sont coupées en deux. Le booléen fait le travail.

Le seul vrai arbitrage : sur les **baisses**, `true` laisse vos abonnés actuels payer plus
cher que les nouveaux dans le même pays. Peu de monde, mais c'est un motif de litige et de
demande de remboursement. `false` sur les baisses seules est défendable si vous avez déjà
des abonnés dans les pays concernés.

---

## Décision 6 — Le rythme d'entretien

Dès que vous fixez un prix à la main, **Apple cesse d'ajuster ce territoire tout seul**.
Sur les monnaies volatiles, votre revenu net fond sans que rien ne vous alerte.

Décidez maintenant : soit vous relancez `init` puis `plan` une fois par trimestre (dix
minutes), soit vous restreignez le périmètre aux pays dont la devise est stable ou qui sont
facturés en dollars. Ne partez pas du principe que c'est un réglage définitif.

---

## Comment l'indice est calculé

```
indice = √( (RNB/hab PPP × part du revenu des 10 % les plus riches) / idem pays de référence )
```

Données Banque mondiale, API publique et gratuite, aucune clé requise. Le RNB par habitant
en PPP mesure le pouvoir d'achat réel ; la part du décile supérieur corrige le fait que
votre acheteur n'est pas l'habitant moyen ; la racine amortit le reste, la consommation de
cette population étant largement importée donc payée aux prix mondiaux. Puis on borne entre
plancher et plafond.

Le prix cible n'est jamais converti à la main : on part de ce qu'Apple mettrait tout seul
dans ce territoire (son « equalization » du prix de référence, taxes et arrondi local
compris) et on lui applique l'indice. Aucun taux de change n'est manipulé.

---

## Procédure

```bash
node ppp_pricing.js produits                              # 1. lister les abonnements
node ppp_pricing.js init --produits=<id>,<id> --ref=FRA   # 2. construire la config
node ppp_pricing.js plan                                  # 3. simuler, LIRE le tableau
node ppp_pricing.js apply --territoire=<un pays test>     # 4. un territoire témoin
node ppp_pricing.js apply                                 # 5. dérouler
```

Relisez le tableau de l'étape 3 ligne à ligne avant d'appliquer — c'est le seul moment où
une erreur d'indice se voit. Puis écrivez **un seul territoire** à faible enjeu, relisez le
prix depuis l'API, et seulement ensuite déroulez.

Prérequis : une clé App Store Connect API de rôle **App Manager** ou **Admin** (Users and
Access → Integrations). Une clé de reporting ne suffit pas : elle lit les prix mais un
403 tombera à l'écriture.

---

## Après

Les prix prennent effet le lendemain, pas immédiatement.

Ne jugez pas au taux de conversion trial : dans un pays où vous n'aviez aucun volume, il
sera bruité pendant des semaines. Regardez le **revenu par install** par pays, et comparez
au coût d'acquisition local. Un prix deux fois plus bas sur un marché où le CPI est cinq
fois moins cher reste beaucoup plus rentable — c'est tout l'intérêt de l'opération.

---

## Notes techniques

Trois choses non documentées côté Apple, déjà gérées par le script mais utiles si vous
écrivez votre propre version :

- `SubscriptionPriceCreateRequest` a trois attributs et les trois comptent : `planType`
  (sinon un produit à plusieurs plans reçoit son prix sur le mauvais plan),
  `preserveCurrentPrice`, et `startDate` — **obligatoire et au minimum J+1** (à `null`,
  Apple comprend « prix initial » et refuse tout produit déjà approuvé).
- L'index de prix Apple (le champ `p` de l'ID base64 d'un price point) est **global** : un
  ID se forge pour n'importe quel produit, donc une grille de territoire chargée une fois
  sert pour tous vos produits.
- Un produit qui propose l'annuel **et** l'annuel payable au mois impose une cohérence
  entre les deux plans : Apple refuse tout écrit qui laisserait le produit dans un état
  intermédiaire (`INVALID_PRICE_TOO_HIGH` / `TOO_LOW`), quel que soit l'ordre. Il faut les
  écrire ensemble via `PATCH /v1/subscriptions/{id}` — vérifiez d'abord sur un produit non
  vendu que ce PATCH ajoute les prix au lieu de remplacer l'intégralité de la grille.
