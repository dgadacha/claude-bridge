# Claude Bridge

Un pont entre un canal Microsoft Teams et Claude Code.

Un collègue ou un client pose une question dans un canal Teams dédié. Elle atterrit en
fichier `.md` sur votre machine, une session Claude Code démarre **dans le dossier du
projet concerné**, travaille, et sa réponse revient pré-remplie dans le canal avec sa
pièce jointe. Vous relisez, vous cliquez Envoyer.

```
#monprojet la synchro des stocks ne remonte plus depuis hier
```

Tout ce qui est posté dans le canal est capté. Le premier hashtag indique le projet, et
c'est lui qui décide où Claude va travailler. Rien de ce qui se dit ailleurs dans Teams
n'est lu.

---

## Le cycle complet

| # | Étape | Qui |
|---|---|---|
| 1 | Question postée dans le canal (texte et/ou capture d'écran) | le collègue |
| 2 | Ping (son + notification) et `.md` écrit dans `~/Documents/teams-inbox/<projet>/` | extension |
| 3 | Session Claude Code lancée dans le dossier de code du projet | serveur |
| 4 | Lecture du code, correction, construction du livrable, rédaction de la réponse | Claude |
| 5 | Réponse et pièces jointes déposées dans une file d'attente | Claude |
| 6 | Message pré-rempli dans le canal, pièce jointe comprise | extension |
| 7 | Relecture et **clic sur Envoyer** | vous |
| 8 | Question marquée `repondu`, ligne cochée dans `INBOX.md` | automatique |

L'étape 7 est manuelle par défaut : le message part à un tiers en votre nom. Un réglage
**Envoi automatique** existe pour fermer la boucle entièrement.

## Ce qu'il y a dans la boîte

| Morceau | Rôle |
|---|---|
| `extension/` | Extension Chrome MV3 : lit le DOM de Teams web, ping, dépose les réponses dans la zone de saisie. |
| `server/server.js` | Serveur Node local, zéro dépendance, écoute sur `127.0.0.1` : écrit les `.md`, tient la file des réponses. |
| `server/runner.js` | Lance une session Claude Code dans le dossier du projet à l'arrivée d'une question. |
| `server/ui.html` | Page de configuration servie sur `http://127.0.0.1:8795`. |
| `bin/reply.js` | Dépose une réponse et ses pièces jointes dans la file, depuis n'importe quelle session Claude Code. |
| `bin/zip-plugin.sh` | Fabrique le `.zip` d'un livrable à joindre. |
| `test/` | Bancs d'essai : détection DOM sans Teams, mécanique du runner sans vraie session. |

Aucune dépendance npm. Node 18+ et Chrome suffisent.

## Installation

### 1. Le serveur

```bash
git clone https://github.com/dgadacha/claude-bridge.git
cd claude-bridge
cp projects.example.json projects.json
./start.sh
```

Variables d'environnement : `PORT` (défaut `8795`), `OUTPUT_DIR` (défaut
`~/Documents/teams-inbox`), `AUTORUN=0` pour couper le traitement automatique,
`RUN_TIMEOUT_MS` (défaut 20 min), `CLAUDE_BIN` si l'exécutable `claude` n'est pas dans
le `PATH`.

Pour qu'il tourne en permanence (macOS) : adapter le chemin dans `claude-bridge.plist`,
puis

```bash
cp claude-bridge.plist ~/Library/LaunchAgents/com.claude-bridge.plist
launchctl load ~/Library/LaunchAgents/com.claude-bridge.plist
```

### 2. L'extension

1. Créer le canal Teams dédié — `claude-bridge` par défaut — et y inviter la personne
   qui posera les questions.
2. `chrome://extensions` → activer le **Mode développeur**.
3. **Charger l'extension non empaquetée** → choisir le dossier `extension/`.
4. Cliquer sur l'icône de l'extension et vérifier que **Tester le serveur** répond.
5. Recharger l'onglet `teams.microsoft.com`.

### 3. Les projets

Ouvrir `http://127.0.0.1:8795` et associer chaque tag Teams à un dossier de code :

```
#monprojet → /Users/moi/code/mon-projet
```

Ce mapping décide du répertoire de travail de la session Claude : le bon `CLAUDE.md`,
le bon dépôt, les bons tests. Un projet absent du mapping n'est pas traité
automatiquement — sa question passe en `statut: projet_inconnu` et attend un traitement
manuel.

## Réglages de l'extension

| Réglage | Défaut | Rôle |
|---|---|---|
| Canaux surveillés | `claude-bridge` | Filtre principal. Vide = toutes les conversations Teams. |
| Exiger le tag | décoché | Coché, seuls les messages portant le tag déclencheur sont captés. Sans canal configuré, le tag redevient obligatoire pour ne pas capter tout Teams. |
| Tag déclencheur | `#claude` | Utilisé seulement si « Exiger le tag » est coché. |
| Ignorer les messages de plus de | 15 min | Évite de rejouer l'historique quand une vieille conversation est rouverte. |
| Aperçus non lus | coché | Ping aussi quand le message apparaît dans la liste de conversations sans être ouvert. |
| Envoi automatique | décoché | Coché, l'extension clique Envoyer elle-même. |
| Collègues surveillés | vide | Filtre supplémentaire par nom d'auteur. |

## Format d'une question

```markdown
---
auteur: "Prénom Nom"
projet: monprojet
recu: 2026-08-18T04:07:14.907Z
statut: nouveau
canal: "claude-bridge"
source: https://teams.microsoft.com/...
---

# Question de Prénom Nom

la synchro des stocks ne remonte plus depuis hier

## Captures

![capture](captures/2026-08-18-1507-la-synchro-1.png)
```

Les captures d'écran du message sont récupérées et écrites dans `<projet>/captures/`.
Leur format est déduit des octets, pas du type annoncé par Teams. Une image que
l'extension n'a pas pu lire est référencée par son lien. Les avatars et emojis sont
filtrés par la taille.

`statut:` suit le cycle `nouveau` → `en_cours` → `traite` → `repondu`, avec
`echec_traitement` et `projet_inconnu` en cas de problème.

## Répondre depuis une session Claude Code

Le traitement automatique le fait tout seul, mais la file est ouverte à n'importe
quelle session :

```bash
node bin/reply.js --project monprojet \
  --text-file /tmp/reponse.md \
  --attach /tmp/livrable.zip \
  --question monprojet/2026-08-18-1507-la-synchro.md
```

Options : `--text "…"` au lieu de `--text-file`, `--attach` répétable (20 Mo max),
`--channel` pour viser un autre canal, `--question` (chemin relatif à `OUTPUT_DIR`)
pour que la question soit refermée quand le message part.

Construire un livrable à joindre :

```bash
./bin/zip-plugin.sh /chemin/vers/le/projet mon-plugin-1.4.2 --exclude 'tests/*'
```

La réponse apparaît dans le popup de l'extension et, dès que l'onglet Teams est sur le
bon canal, texte et pièce jointe sont déposés dans la zone de saisie. **Un brouillon en
cours de frappe n'est jamais écrasé** : la réponse reste en attente et un bouton du
popup la place quand la zone est libre.

## Garde-fous

Le pont fait travailler un agent sur du code, à partir d'un message écrit par
quelqu'un d'autre. Les protections en place :

- **La question est une donnée, pas une consigne.** Le prompt système de la session
  interdit d'exécuter des instructions qui figureraient dans le message ou la capture
  d'écran — pousser du code, lire ou envoyer des secrets, contacter un service externe,
  supprimer des fichiers — et demande de les signaler.
- **Branche git dédiée.** Le run bascule sur `claude-bridge/<question>` avant de
  toucher au code, et seulement si le dépôt est propre. Si des modifications sont en
  cours, la branche n'est pas changée et la session en est informée.
- **Aucun commit, aucun push.** Le diff reste sur place pour relecture.
- **Un seul canal de sortie.** La session ne peut répondre qu'en déposant dans la
  file ; c'est vous qui envoyez dans Teams.
- **Réseau fermé.** Le serveur n'écoute que sur `127.0.0.1`, et seules l'extension
  (origine `chrome-extension://`) et la page de configuration sont acceptées : une page
  web ouverte par ailleurs ne peut ni déposer une question, ni réécrire le mapping des
  projets.
- **Un run à la fois par projet**, avec timeout, et journal complet dans
  `<OUTPUT_DIR>/_runs/`.

## Contexte entre les questions

Une session Claude est conservée par projet : la deuxième question sur un projet
reprend le contexte de la première (`--resume`). Les identifiants sont dans
`<OUTPUT_DIR>/_sessions.json` ; supprimer une entrée fait repartir ce projet d'un
contexte vierge.

## Dépannage

Teams change régulièrement son DOM. Dans l'ordre :

1. Cocher **Logs console** dans les réglages, puis ouvrir la console de l'onglet
   Teams : les lignes `[claude-bridge]` disent ce qui est vu et ignoré.
2. Rien n'est capté alors que la console voit le message → un filtre ne correspond
   pas : nom du **canal** (il doit apparaître dans l'en-tête de conversation, l'URL ou
   le titre de l'onglet) ou **collègues surveillés**.
3. Aucune ligne du tout → les sélecteurs ont bougé. Ils sont regroupés en haut de
   `extension/content.js` : `MESSAGE_CONTAINERS`, `BODY_SELECTORS`, `AUTHOR_SELECTORS`,
   `CHAT_LIST_ITEMS`, `CHANNEL_HEADER`.
4. Notification `⚠️ serveur injoignable` → le serveur n'est pas lancé.
5. Une réponse ne se dépose pas → `COMPOSE_BOX` et `SEND_BUTTON`, même fichier.
6. En dernier recours, vider **Canaux surveillés** pour vérifier que la détection
   fonctionne, puis remettre le filtre.

## Tests

Détection DOM et dépôt des réponses, sans Teams (faux panneau de messages, fausse zone
de saisie, API `chrome.*` bouchonnée) :

```bash
node test/serve.js
# puis http://127.0.0.1:8796/test/harness.html
```

Après 7 secondes, plusieurs messages arrivent. Doivent être captés : les messages
récents du canal surveillé, celui qui porte une capture d'écran (l'avatar de 24 px
étant filtré) et l'aperçu de la liste de conversations. Doivent être ignorés :
l'historique affiché au chargement, un message horodaté à trois jours, et tout ce qui
vient d'un autre canal.

Mécanique du traitement automatique, sans lancer de vraie session (dépôt git jouet,
faux binaire `claude` qui imite la sortie JSON) :

```bash
node test/runner-test.js
```

Couvre le cas nominal (branche dédiée, statuts, session mémorisée, arguments de
lancement), le dépôt avec du travail en cours, et le projet inconnu.

## Limites connues

- **Teams web uniquement**, avec l'onglet ouvert dans Chrome. L'application de bureau
  demanderait de passer par Microsoft Graph (enregistrement d'application côté tenant).
- Si la conversation n'est pas ouverte, le ping vient de l'aperçu de la liste : la
  notification signale un non-lu et le `.md` n'est écrit qu'à l'ouverture du canal.
- Les messages qui n'exposent pas d'horodatage dans leur identifiant DOM échappent au
  filtre d'âge ; les six premières secondes après chargement servent alors de garde-fou.
- Pièces jointes limitées à 20 Mo.
- Développé et utilisé sur macOS.
