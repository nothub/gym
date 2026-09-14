# Timer strategies

## Intent

Confirmed 2026-09-14. Revised the same day to drop exercise lists entirely.

- **Outcome:** the timer covers the formats actually trained, not just EMOM.
- **User:** one person, phone propped up in a gym, desktop browser too.
- **Why now:** EMOM alone does not cover the training.
- **Success:** all three formats work, and "12 minutes, go" is still two taps.
- **Constraint:** vanilla HTML/CSS/JS, no build step beyond the version stamp, one self-contained page, works offline.
- **Out of scope:** exercise lists of any kind, the generator, coaching rules, session history.

This app is a clock. It never knows what movement is being performed.

## Strategies

Three, not four. EMOM is `Intervals(60s work, 0s rest)`: the rest in an EMOM is
implicit leftover, which is what a zero-length prescribed rest means. Cues fire
at the same transitions, a round means the same thing, and there is no rest
phase to display either way.

| Strategy | Clock | Fixed | Scored |
| --- | --- | --- | --- |
| Intervals | drives everything | interval cycles | nothing |
| AMRAP | counts down | the window | rounds, by tap |
| RFT | counts up | rounds | elapsed time |

AMRAP and RFT do not collapse into Intervals. One counts down while the athlete
taps, the other counts up, and both produce a result rather than a cue.

### Intervals

`work` seconds, then `rest` seconds, repeated `intervalCycles` times. The clock drives
every transition. Nothing to tap.

Presets: **EMOM** 60/0, **E2MOM** 120/0, **Tabata** 20/10 x 8.

The Tabata preset names a timing convention, not the protocol. The 1996 paper
prescribes 7 to 8 sets rather than a flat 8, on a cycle ergometer at roughly
170% VO2max, with trained subjects, inside a six-week programme. It also credits
the interval structure to speed-skating coach Kouichi Irisawa rather than to
Tabata. The commonly repeated "20/10 x 8" borrows the clock and nothing else.

Ship the convention, because the clock is the only part a timer can offer, and
do not let the label imply the rest.

> Tabata I, et al. Effects of moderate-intensity endurance and high-intensity
> intermittent training on anaerobic capacity and VO2max.
> Med Sci Sports Exerc. 1996;28(10):1327-1330. PMID 8897392.

### AMRAP

One countdown over the `amrapWindow`. Tap to record a completed round. The
app counts taps; it has no idea what a round contained and does not need one.
Ends when the clock runs out. Reports rounds completed.

### RFT

Count-up stopwatch. Tap to record a completed round. Ends on the `rftRounds`th tap.
Reports elapsed time.

## The clock

`derive(elapsed, config)` stays a pure function of elapsed milliseconds, with no
DOM and no clock inside it. That is what keeps the minute boundaries free of
drift and the whole thing testable without a browser. Each strategy is a branch;
every branch stays pure. Tap counts are state held outside it and passed in.

```
Intervals   cycle = work + rest
            cycle# = floor(t / cycle) + 1         -> done when > intervalCycles
            inCycle = t % cycle
            inCycle < work  -> work, remaining = work - inCycle
            otherwise       -> rest, remaining = cycle - inCycle

AMRAP       t >= total -> done
            otherwise  -> work, remaining = total - t
            round is the tap count, not derived from t

RFT         always counting up, remaining is unbounded
            done when the round count reaches rftRounds
```

With `rest = 0` the cycle equals the work period and `inCycle < work` always
holds, so the Intervals branch produces exactly today's EMOM behaviour. That is
the check that the collapse is real rather than asserted.

## Cues

Unchanged in kind: three short beeps leading into a transition, a longer one to
mark it, a full-screen flash at the same moment, optional buzz.

- **Intervals** cues every transition, work to rest and rest to work. With
  `rest = 0` there are only work-to-work transitions, which is today's behaviour.
- **AMRAP** cues the last three seconds and the finish. No intermediate
  boundaries exist.
- **RFT** counts up, so there is nothing to count down to. Cue the finish only.

## Screens

**Setup.** Opens on the EMOM preset showing a cycle count, as today. The preset
buttons are the primary interface; `work` and `rest` are revealed behind a
Custom affordance rather than shown by default. Four visible controls where
there is one today would be a regression for the case used daily.

**Timer.** As today: progress label, countdown, phase, controls. The progress
label reads "Cycle 3 / 12" under Intervals and "Round 7" under AMRAP or RFT,
because those count different things. In AMRAP and RFT
the countdown area is the tap target, large because the athlete is breathing
hard and not aiming carefully.

**Done.** Gains a result line for AMRAP (rounds completed) and RFT (elapsed).
Intervals has nothing to report and keeps today's screen.

## Persistence

One `localStorage` entry, as now. Gains the selected strategy and the preset or
custom work/rest values. Nothing else changes.

## What this app is not

It holds no exercises, no named workouts, no prescriptions, and no programme
structure. Research into published sessions was done and then discarded: naming
a movement is the first step towards recommending one, and recommending one
means standing behind a claim about training that a clock has no business
making. The only domain claim left in the project is the Tabata caveat above,
which exists to stop a preset label overstating itself.
