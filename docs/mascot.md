# Meet the Mascot 🐦

<img src="assets/mascot.svg" width="200" alt="Phae, a pixel-art hermit hummingbird">

## Phae, the Trap-liner — Knows Which Flowers Have Refilled

> **Meet the Hermit** 🐦
> "I keep a circuit. I know every flower on it, I know when I last drained each one, and I know which ones have filled back up. I'm not lost out here. I'm working a route."

### Who Is This Animal?

Meet Phae — a hermit hummingbird, genus *Phaethornis*, a bird whose entire foraging
strategy is the problem this tool solves. Hermits don't defend one patch. They
**trap-line**: they work a long, repeatable circuit of widely scattered flowers,
returning to each one on its own schedule.

Which means a hermit is not tracking *where the food is*. It's tracking **where the
food is, and when I was last there, and therefore whether it's worth going back yet** —
across dozens of sites held in parallel, with no two on the same clock.

That's the switcher. Not "list my sessions." *Which of these is worth returning to now.*

Fun fact: this isn't a stretch metaphor bolted on afterwards. Rufous hummingbirds
studied by Healy and Hurly were shown to remember not just which flowers they'd
visited but **how long ago**, and to time their returns to each flower's refill rate.
Location plus elapsed time, per site, in parallel. The biology and the architecture
are the same diagram — the bird just got there about forty million years earlier.

### Hummingbird Facts (With Session-Switching Translation)

**Fact #1:** Hermits trap-line — a repeatable circuit of scattered flowers rather
than one defended patch. Their whole economy assumes many sites, none of them home.
**Translation:** The switcher assumes you have a dozen things open across a dozen
directories, and that this is *fine*. It doesn't ask you to consolidate. It makes the
return trip cheap.

> "I don't have a territory. I have a route."

*Roast:* Holds an entire foraging circuit in a brain the size of a grain of rice. This
tool needs a 53 KB index, a schema version and a cache-invalidation rule to hold
thirteen files.

---

**Fact #2:** They track elapsed time per flower, returning as each one refills rather
than on a fixed loop.
**Translation:** Every row carries its own last-active time and a 16-cell strip of
when in its life the session was busy. A burst-then-idle debugging session and a
steady refactor read differently at a glance, before you read a word.

> "That one's still empty. I was there twenty minutes ago."

*Confession:* Times its returns by an internal clock accurate to the minute. The
strip folds everything into sixteen cells and calls it a day.

---

**Fact #3:** A hummingbird's blue-green isn't pigment — it's structural colour. The
same feather is a different colour depending on the angle you view it from.
**Translation:** Project colours are hashed, so one list shows one hue per repo and
the same repo is always the same hue. One bird, many colours, depending where you
look from.

> "Same feathers. You just moved."

*Roast:* Produces iridescence from the physical structure of keratin. We do it with
`charCodeAt` and a modulo.

---

**Fact #4:** They hover — wings at fifty beats a second — precisely so they never have
to commit to landing.
**Translation:** `/switcher #wip` is registered `immediate`, so you can mark a session
while a turn is still streaming. Tag it without landing on it.

> "I'm not stopping. I'm just marking this one."

*Contradiction:* Sustains hovering flight, the most metabolically expensive movement
of any vertebrate, indefinitely. Cannot read a file over 4 MiB without shelling out to
`sed`.

---

**Fact #5:** Hermits are among the plainest hummingbirds — no flashing display, long
curved bill, drab olive-brown. They're built for the route, not for the show.
**Translation:** This is a list in a pane. No animation, no chrome, two lines a row.
The point is the trip home, not the plumage.

> "The pretty ones are defending a hedge somewhere. I've got eleven kilometres to
> cover before dark."

*Roast:* Admirably unshowy. Immediately rendered in eight colours and given a
gorget it does not, strictly speaking, have.

---

**Fact #6:** A hummingbird enters torpor overnight — heart rate and body temperature
dropping until it is barely alive — because holding that much readiness is
unaffordable when nothing is happening.
**Translation:** The index sleeps. Opening the switcher reads no transcript at all,
just the cached index and a `stat` per file. It wakes only for what changed.

> "I'm not dead. I'm just not spending anything."

*Confession:* Drops its heart rate from 1,200 to 50 to survive a cold night. Our
version of thrift is not re-reading a file whose mtime hasn't moved.

---

## The Pixels

Twenty-four by sixteen, eight colours, chunky in the same family as Claude Code's own
terminal sprite — but in profile, which is the one place it departs.

That departure was learned the hard way. The first attempt was front-facing with two
eyes, closer to Clawd, and it read as a blue character in a flat cap: the wide crown
and the level bill became a brim, the forked tail below an upright body became legs,
and the wing blur became mittens. Clawd can be a blob because it is *ambiguous by
design*. A hummingbird is a silhouette animal, and a silhouette animal needs its
profile — long bill forward, body tilted, tail swept back, wings blurred through the
stroke. One eye, and the bird is legible.

The last correction was the underwing. Drawn tapering downward it read as a foot;
swept down-left instead, against the upper wing's sweep up-right, it reads as one
stroke of the figure-eight a hovering hummingbird actually flies. Nothing in the
sprite is symmetric, which is what keeps it from looking like it is standing still.

The palette is not decorative. `#7aa2f7` is the first entry in the switcher's own
project-hue table — the mascot is wearing the colour your first project is drawn in.

```
........................
.................ww.....
................WWww....
.......DDDD....WWWw.....
......DDDDDDD.WWWW......
YYYYYYDDBKBBDWWWW.......
.YYYYYDBBBBBBWWW........
......GGBBBBBBBW........
.....GGGBBBBBBBB........
.....GGBBBBBBBBBBT......
......BBBBBBBBBBTTTTT...
......WBBBBBBBWTTTTTT...
....WWWWBBBBWWWTTTT.....
..wWWWW.................
...ww...................
........................
```

| | | |
|---|---|---|
| `Y` bill `#2f3549` | `D` crown `#3b5bb5` | `K` eye `#11131a` |
| `B` body `#4c7fe0` | `G` gorget `#f7768e` ← project hue 6 | `T` tail `#2f4487` |
| `W` wing `#7aa2f7` ← project hue 1 | `w` wingtip `#a9c4fb` | |

The wing is the project hue itself. It started a shade lighter, which read fine at
README size and dissolved into the page below about 32 pixels — a blue blob with a
bill. Only the two tips keep the lighter value now, where a fade reads as a stroke
ending rather than as fog.

The grid is the source. Edit it, regenerate the SVG, and merging runs keeps it to
about forty rects.

## The render

`assets/mascot-render.png` is a 3-D treatment of the same sprite, and
`assets/mascot-social.png` is it sized for GitHub's social preview — the card that
shows when the repo is linked on LinkedIn, X or Slack.

It is kept here for provenance, not for use on this page. The argument above is that
the sprite has to stay flat and legible small; a beveled render with bloom would
contradict the paragraph it sat next to, and it is built for a black background that
GitHub's light theme does not give it. **`mascot.svg` is the mascot.** The render is
what the mascot looks like on a poster.

The card is scaled rather than cropped: at 3:2, cropping to the 2:1 a social preview
wants would take both wing tips off, which are the shapes doing the most work. The
background is black, so padding the sides instead is invisible and the bird survives
whole.

One known drift from the sprite, left as it is: the render floats the gorget in front
of the chest as a separate block, where on the sprite it is attached to the throat
under the bill.
