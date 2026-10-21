# 🎴 Skyclub 1.2 — Skyjo multijoueur, sans compte

Site multijoueur indépendant pour **2 à 8 personnes par salon**. Aucun compte à créer : choisis un **pseudo** puis **crée ou rejoins un salon** avec un code à **8 caractères** (ou un lien d’invitation). Les parties sont synchronisées en direct et enregistrées côté serveur.

> Projet indépendant, non affilié à Magilano. L’interface et les cartes sont des créations originales.

## 1 — Mise à jour d’une ancienne version

1. **Arrête l’ancien serveur** dans son terminal avec `Ctrl + C` (attends son arrêt complet pour que les parties soient sauvegardées).
2. **Sauvegarde** le fichier `skyclub/data/store.json` si tu en as un, pour ne pas perdre les parties.
3. **Extrais `Skyclub-v1.2-Sans-Compte.zip` au-dessus du dossier existant**, depuis son répertoire parent, en remplaçant les fichiers de code. Le ZIP contient un répertoire `skyclub/` et **n’inclut jamais le dossier `data/`**, qui doit être conservé.
4. Depuis le dossier `skyclub/`, lance :

```bash
npm test
npm start
```

5. Visite **http://localhost:3000**. Fais `Ctrl + Maj + R` dans le navigateur si tu vois encore les anciens écrans.

Sur macOS/Linux (depuis le parent de `skyclub/`, adapte le chemin de Downloads) :

```bash
cp skyclub/data/store.json skyclub/data/store.json.bak  # si ce fichier existe déjà
unzip -o ~/Downloads/Skyclub-v1.2-Sans-Compte.zip -d .
cd skyclub
npm test
npm start
```

Sur Windows PowerShell, depuis le parent du dossier `skyclub/` :

```powershell
Copy-Item .\skyclub\data\store.json .\skyclub\data\store.json.bak # s'il existe
Expand-Archive -Path "$HOME\Downloads\Skyclub-v1.2-Sans-Compte.zip" -DestinationPath . -Force
cd skyclub
npm test
npm start
```

Si tu pars de zéro, décompresse le fichier et lance `npm start` dans `skyclub/`. Il faut **Node.js 22 ou plus récent**. Il n’y a **aucune dépendance npm à installer**.

**Migration :** les anciens comptes sont transformés en invités. Les anciens mots de passe ne servent plus, ni les routes de connexion/inscription. Les anciens codes de salon à 6 caractères restent acceptés pour les parties préexistantes ; chaque nouveau salon reçoit un code à 8 caractères. Les cookies invités déjà valides continuent à identifier le même joueur, ce qui préserve les places dans les salons. Si quelqu’un a perdu son cookie et ne peut plus reprendre son ancien joueur, il peut rejoindre le salon avec un autre pseudo tant que la partie n’a pas commencé.

## 2 — Partager Skyclub avec des amis à distance

- `http://localhost:3000` est **local à TON ordinateur** : tes amis éloignés ne peuvent pas l’ouvrir.
- **Méthode rapide pour tester avec tes amis** : installe [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), démarre `npm start`, puis dans **un deuxième terminal** lance :

```bash
cloudflared tunnel --url http://localhost:3000
```

Une URL aléatoire `https://....trycloudflare.com` est affichée : **c’est celle à envoyer à tes amis**. Ils choisissent un pseudo, puis utilisent un lien d’invitation Skyclub ou entrent ton code de salon. Ton ordinateur, Skyclub et le tunnel doivent rester allumés. Cette solution est **temporaire (tests / soirées privées)**, pas un hébergement permanent. Aucun port de ta box n’est à ouvrir. **Important :** pour faire fonctionner les cookies sécurisés et les WebSockets derrière ce tunnel, lance Skyclub avec `TRUST_PROXY=1` (voir ci-dessous), puis ouvre l'URL HTTPS, pas `localhost` pour jouer à distance.

```bash
# macOS / Linux :
TRUST_PROXY=1 npm start
# Windows PowerShell :
$env:TRUST_PROXY="1"; npm start
```

- **Méthode permanente** : héberge Skyclub comme **service Node.js** sur Render / Railway ou un VPS avec HTTPS, WebSockets, **une seule instance** et **disque persistant**. Par exemple, sur Render : connecter le repo Git, créer un *Web Service*, définir `npm start`, `TRUST_PROXY=1`, `DATA_DIR=/var/data` et joindre un disque au point de montage `/var/data`. Sur ces plateformes, utiliser le `PORT` fourni. **Attention, un service sans disque persistant perdra les parties au redéploiement ou redémarrage.** Ce service te donnera une URL stable en `https://...onrender.com` (ou ton propre domaine).

- **Sur le même Wi-Fi uniquement** : tu peux écouter sur l’adresse réseau avec `HOST=0.0.0.0 npm start` (PowerShell : `$env:HOST="0.0.0.0"; npm start`) et donner `http://IP_LOCALE_DU_PC:3000`. Cette option n’est pas adaptée à Internet sans HTTPS. Le pare-feu de l’ordinateur doit permettre l’accès local au port 3000.

## 3 — Protections incluses

- **Aucun mot de passe enregistré**. Chaque navigateur reçoit un **cookie de session invité `HttpOnly` + `SameSite=Strict`**, et `Secure` quand le site est servi en HTTPS via un proxy de confiance. Il permet de reprendre la même place après reconnexion : **ne supprime pas les cookies en cours de partie**.
- **Contrôle des règles côté serveur** : personne ne peut choisir son tour, consulter les cartes cachées des autres, lancer une partie sans être hôte, dépasser **8 joueurs**, rejoindre une partie déjà commencée ou reprendre l’identité d’un autre joueur avec son pseudo.
- **Codes de salon aléatoires cryptographiquement** sur 8 caractères. Un code donne l’accès à un salon en attente : ne le diffuse qu’aux personnes invitées. Il n’y a pas de compte permanent pour attester l’identité réelle de tes amis.
- Vérification de **l’Origin** des WebSockets et des requêtes JSON, blocage des demandes cross-origin, protection anti-XSS dans l’interface, en-têtes de sécurité (CSP, anti-iframe, `nosniff`, `Referrer-Policy`, restrictions caméra/micro), limites de taille des requêtes et messages et protection contre les WebSockets malformés.
- Limitation des **tentatives de rejoindre un salon**, des créations de salons, des sessions invitées, du nombre de connexions et d’onglets, et des messages de jeu par seconde ; déconnexion des clients lents et inactifs.
- Élimination des salons inutilisés après 2 jours d’inactivité (avant début) ou 14 jours (parties lancées). Écriture de `store.json` via renommage atomique et regroupement des modifications, sauvegarde finale lors d'un arrêt propre.
- Serveur local écoutant par défaut sur **127.0.0.1** (pas directement sur Internet). Le Docker Compose publie également `127.0.0.1:3000` pour éviter une exposition non souhaitée sans HTTPS.

**Limites à connaître :** le code de salon remplace un système d'invitations authentifiées : toute personne qui le possède peut se joindre à un salon **avant** le début (si le salon n'est pas complet), et les invités ne disposent pas de récupération de compte. Un utilisateur malveillant peut toujours faire du déni de service ; les limitations du serveur ne remplacent pas les protections réseau de l’hébergeur. N'expose pas le port 3000 en HTTP directement sur Internet. Protéger le disque `data/`, n'envoie jamais le fichier `store.json` à tes amis.

`TRUST_PROXY=1` **uniquement derrière un reverse proxy HTTPS de confiance** qui fournit et remplace l'en-tête `X-Forwarded-Proto` (Cloudflare Tunnel, Render, ou un Caddy/Nginx correctement configuré). Ne laisse pas cette option activée sur un port HTTP directement accessible au public.

## 4 — Docker (serveur privé / proxy)

```bash
docker compose up -d --build
docker compose logs -f
```

Le conteneur conserve ses données sur le volume `skyclub-data`. Docker publie le port **sur localhost du serveur** ; mets un reverse proxy HTTPS devant. Le fichier `compose.yaml` utilise déjà `TRUST_PROXY=1` pour une telle configuration.

## 5 — Le jeu et les tests

- 150 cartes : 5×−2, 10×−1, 15×0, 10 cartes pour chaque nombre de 1 à 12.
- Grilles 4 colonnes × 3 lignes, deux cartes retournées au départ, pioche/défausse, suppression des colonnes de trois cartes identiques et score final automatique à partir de 100 points.
- Reconnexion automatique à la partie, possibilité de changement de pseudo (sans créer un nouveau joueur), hôte remplaçable quand il est hors ligne.
- Jusqu’à 400 salons enregistrés par instance (10 salons par invité), 512 WebSockets simultanés maximum configurables via `MAX_SOCKETS`; seuls 8 joueurs peuvent être dans un salon.

```bash
npm test    # test du jeu à 8, sécurité, persistance, HTTP / WebSockets
npm run perf
```

Aucun benchmark en conditions réelles sur Internet ne garantit la latence ou les performances d’un hébergeur donné. Skyclub reste un petit serveur mono-instance avec sauvegarde JSON et ne vise pas une communauté massive. Pour une forte charge, migrer vers base de données transactionnelle et sessions distribuées.
