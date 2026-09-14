# gym-timer

An interval timer for conditioning work. It is a clock and nothing else: it
never knows what movement is being performed.

## Language

**Strategy**:
One of the three timer shapes: Intervals, AMRAP, RFT. Determines what is fixed,
what is measured, and whether the clock or the athlete drives transitions.
_Avoid_: mode, type, format, workout type

**Interval cycle**:
One work period plus the rest period that follows it. The unit Intervals
repeats. A cycle with zero rest is a single uninterrupted work period, which is
what makes EMOM `Intervals(60s work, 0s rest)`.
_Avoid_: round, interval, rep, set

**Round**:
One pass through the athlete's own work, recorded by a tap. The app counts
rounds; it never knows what one contained. AMRAP counts them as its score, RFT
counts down to a target. Partial rounds are not representable, because the app
cannot see reps.
_Avoid_: lap, cycle, rep, set

**Window**:
The fixed span of time an AMRAP runs for. A duration, not a count. This is the
distinction that the single "rounds" input used to hide.
_Avoid_: rounds, duration, time cap, limit

**Work period**:
The part of an interval cycle during which the athlete works. Followed by a rest
period, which may be zero.
_Avoid_: interval, on, active

**Prep**:
The fixed countdown before the first work period, so the athlete can get set.
_Avoid_: countdown, lead-in, get ready, warmup

**Cue**:
A signal marking a transition or the seconds leading into one. Delivered as
sound, screen flash, and buzz, independently switchable.
_Avoid_: alert, notification, beep, alarm

**Build id**:
The short commit hash of the deployed build, stamped into `version.js` at deploy
time. Names the service worker cache and appears in the footer.
_Avoid_: version, release, build number

## Qualified forms

Where a field or label could belong to more than one Strategy, qualify it rather
than relying on context:

| Concept | Config field | On screen |
| --- | --- | --- |
| Interval cycle | `intervalCycles` | "Cycles" |
| Window | `amrapWindow` | "Minutes" |
| Round, as a target | `rftRounds` | "Rounds" |
| Round, as a score | counted at runtime | "Rounds completed" |

"Round" in prose is fine where only one Strategy is in play, because it names one
concept. What this glossary retires is a **field or label called `rounds`**: that
one identifier meant interval cycles, a duration in minutes, and a tap target,
depending on which Strategy was selected, and nothing on screen said which.
