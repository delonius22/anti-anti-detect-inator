# The math, in one place

Every formula the Anti-Anti-Detect-inator uses, with each symbol defined and the file that computes it. GitHub renders the `$$` blocks.

## 1. Hop timing (server)

**H2: hops from the SYN's TTL** (`nginx/syn-ttl-module/`)

$$\text{hops} = \text{TTL}_0 - \text{TTL}_{\text{obs}}, \qquad \text{TTL}_0 = \min\{\,t \in \{64, 128, 255\} : t \ge \text{TTL}_{\text{obs}}\,\}$$

- $\text{TTL}_{\text{obs}}$: the TTL on the arriving SYN packet. Each router subtracts 1.
- $\text{TTL}_0$: the starting value the sender's OS uses. Linux, macOS, iOS and Android start at 64; Windows starts at 128. X3 fires when $\text{TTL}_0$ disagrees with the OS the user agent claims.

**H4: the gap between the page's round trip and TCP's** (`server/scoring.js`)

$$\Delta_{\text{hop}} = \min_{i=1..10} \text{RTT}_{\text{page},i} \;-\; \frac{\text{RTT}_{\text{TCP}}}{1000}$$

- $\text{RTT}_{\text{page},i}$: the 10 WebSocket echoes timed on the server's clock, in ms. The minimum is used because delays only ever add time; the fastest sample is the closest to the true path.
- $\text{RTT}_{\text{TCP}}$: the kernel's smoothed RTT for the WebSocket's own connection, in µs (divided by 1000 for ms). If nginx didn't report it, the page request's value is used.
- Flag when $\Delta_{\text{hop}} > \texttt{RTT\_GAP\_MS}$ (default 50 ms). A proxy ends the TCP connection itself, so TCP sees only the short last leg while the echo travels all the way to the real browser.

**Setting the H4 threshold from data** (`analysis/.../thresholds.py`)

$$\texttt{RTT\_GAP\_MS} = \operatorname{round}\big(Q_{0.99}(\Delta_{\text{hop}} \mid \text{C1} \cup \text{C2})\big)$$

The 99th percentile of the gaps of people and privacy browsers, so about 1 legitimate visit in 100 trips it on its own.

**H5: faster than light** (`server/scoring.js`)

$$d = 2R \arcsin\sqrt{\sin^2\!\tfrac{\Delta\varphi}{2} + \cos\varphi_1 \cos\varphi_2 \sin^2\!\tfrac{\Delta\lambda}{2}}, \qquad R = 6371\ \text{km}$$

$$\text{floor}_{\text{ms}} = \frac{\max(0,\ d - s)}{100}, \qquad \text{flag if } \text{floor}_{\text{ms}} \ge 5 \ \text{and}\ \text{RTT}_{\text{TCP,ms}} < 0.9 \cdot \text{floor}_{\text{ms}}$$

- $d$: great-circle distance (haversine) between your server and the IP's database location; $\varphi$ = latitude, $\lambda$ = longitude, in radians.
- $s$: slack, the database's accuracy radius in km, or 300 km when the database gives none (DB-IP Lite).
- 100: light in fiber covers about 200 km per ms, and a round trip covers the distance twice.
- The report's ratio $\text{RTT}_{\text{TCP}} / \text{floor}_{\text{ms}}$ sits above 1 for honest locations.

**J12: page timezone vs IP** (`server/scoring.js`)

$$\text{expected} = \begin{cases} \text{offset of the IANA zone at } T_0 & \text{(GeoLite2)}\\ 60 \cdot \operatorname{round}(-\lambda / 15) & \text{(longitude only)}\end{cases}, \qquad \text{flag if } |\text{tzOffset} - \text{expected}| > \tau$$

$\text{tzOffset}$ is the page's `getTimezoneOffset()` in minutes (positive west of UTC, hence $-\lambda$). $\tau$ = 60 min with a real zone, 150 min from longitude alone. The Earth turns 15° an hour.

## 2. Scores and weights

**Rule scores** (`server/scoring.js`)

$$S_{\text{agent}} = \sum_{f \in F,\ \text{side}(f) \in \{\text{agent}, \text{both}\}} w_f, \qquad \text{suspectedAgent} \iff S_{\text{agent}} \ge 5$$

Same for $S_{\text{antidetect}}$ with side antidetect or both. $w_f$ is the integer weight on each fired flag.

**Fitting the weights** (`analysis/.../fit.py`). A class-balanced logistic regression gives one coefficient $\beta_f$ per flag. Negative ones are clamped to 0 by default (an attacker could trigger a negative flag on purpose to lower its score). Then:

$$w_f = \operatorname{round}\!\left(\frac{\max(\beta_f, 0)}{\max_g |\beta_g| / 5}\right) \in \{0, \dots, 5\}$$

The threshold is the lowest integer $t$ whose precision on the fitting runs meets the target (default 98%):

$$t^\* = \min\{\, t : \tfrac{\#\{S \ge t \text{ and target}\}}{\#\{S \ge t\}} \ge 0.98 \,\}$$

Lowest qualifying $t$ means the most recall at that precision.

**Signal grades** (`analysis/.../grading.py`): strong if the best-caught tool's rate is at least 90%, the C1 rate at most 1% and the C2 rate at most 5%; supporting at 50% / 5% / 15%.

**CreepJS ratings** (`client/probes.js`): each rating is the share of its checks that came back true, $\text{rating} = 100 \cdot \#\{\text{true}\} / \#\{\text{checks}\}$, rounded.

## 3. The System 1 model (percentages)

`analysis/.../model.py` trains it; `server/model.js` reproduces it to within $10^{-9}$.

**Features.** Each flag is 0 or 1. Numbers are clipped and some are log-scaled, $x = \ln(1 + \min(\max(v, 0), \text{cap}))$, for example the RTT gap (cap 2000 ms) and the CreepJS lie count (cap 500). A missing number becomes 0, plus a separate 0/1 "missing" feature. Then each feature is standardized with the training mean and spread:

$$z_j = \frac{x_j - \mu_j}{\sigma_j}$$

**Probabilities** for the classes $c \in \{\text{human}, \text{agent}, \text{antidetect}\}$:

$$\ell_c = \frac{\mathbf{w}_c \cdot \mathbf{z} + b_c}{T} + \ln\frac{\pi^{\text{live}}_c}{\pi^{\text{train}}_c}, \qquad p_c = \frac{e^{\ell_c}}{\sum_k e^{\ell_k}}$$

- $\mathbf{w}_c, b_c$: the multinomial logistic regression's coefficients and intercept for class $c$.
- $T$: temperature. One number, fitted on out-of-fold predictions by minimizing log loss, $T^\* = \arg\min_{T \in [0.05, 20]} -\frac{1}{N}\sum_i \ln p_{y_i}(T)$. It shrinks overconfident percentages without changing which class wins.
- The last term is the prior shift: $\pi^{\text{train}}$ is the class mix in your lab runs, $\pi^{\text{live}}$ the mix you expect live (`MODEL_PRIORS`). It is zero when you set no priors. This is Bayes' rule applied after the fact.
- Tag: the top class, or `uncertain` when $\max_c p_c < 0.6$. A verified signature overrides it.

**Reasons.** For the winning class $c^\*$, feature $j$'s push is

$$r_j = z_j \left(w_{c^\*,j} - \tfrac{1}{3}\textstyle\sum_k w_{k,j}\right)$$

The top three with $r_j > 0.05$ are listed. Subtracting the class average keeps only what pushes toward $c^\*$ more than toward the others.

**How the report grades the model**

$$\text{log loss} = -\frac{1}{N}\sum_i \ln p_{i, y_i}, \qquad \text{Brier} = \frac{1}{N}\sum_i \sum_c (p_{i,c} - [y_i = c])^2, \qquad \text{ECE} = \sum_{b=1}^{10} \frac{n_b}{N}\,\big|\,\overline{\text{conf}}_b - \text{acc}_b\,\big|$$

ECE (expected calibration error) puts visits into 10 bins by the top percentage and compares the stated confidence with how often the model was right in each bin.

## 4. Rarity and impossible combinations

`analysis/.../rarity.py`. The reference set is C1 + C2, $N$ visits.

**Entropy of an attribute** (AmIUnique / Panopticlick)

$$H = -\sum_v p_v \log_2 p_v, \qquad H_{\text{norm}} = \frac{H}{\log_2 N}$$

$p_v$ is the share of reference visits with value $v$. $H$ is in bits: 1 bit halves the crowd you hide in. $H_{\text{norm}}$ = 1 means every person had a different value.

**Surprisal of one value, leave-one-out with smoothing**

$$P(v) = \frac{c_v - \delta + \alpha}{N - \delta + \alpha (K + 1)}, \qquad s = -\log_2 P(v), \qquad \alpha = 0.5$$

- $c_v$: reference visits with value $v$. $K$: distinct values among them.
- $\delta$ = 1 when the visit being scored is itself a reference visit (leave-one-out), else 0. Without it, every person's own value would count as "seen".
- $\alpha$: additive (Laplace-style) smoothing, so a value nobody showed gets a large but finite cost; the $+1$ in $K + 1$ reserves room for unseen values.

**Per visit:** $\bar{s} = \frac{1}{m}\sum_{j=1}^{m} s_j$ over the $m$ attributes it has, plus its percentile among the reference visits' own $\bar{s}$. The sum $\sum_j s_j$ is also reported, but it assumes the attributes are independent, which they aren't (GPU and WebGL hash move together), so it overstates rarity. Rank by the mean.

**Impossible pair** of coarse values $(a, b)$:

$$c_a - \delta \ge 3, \quad c_b - \delta \ge 3, \quad c_{a,b} - \delta = 0$$

Each value is common enough among people to judge, but no person had both.

## 5. Hashes (no math to tune)

The page's canvas hash is 32-bit FNV-1a. CreepJS hashes are SHA-256. FingerprintJS uses MurmurHash3 x64 128-bit. They only test for equality: same hash, same value.
