# Goals

Brandon's words, verbatim. The design documents answer to this file. Change it only when he restates a goal.

## The two goals

> I'll state the problems/goals as I see them.  There are two:
> - browser render target for the bar.  this would be a fully supported renderer for any users w/ the prerequisites, which will be an Apple Silicon Mac, tmux, claude code.  Same stuff we require today.
> - dev mode renderer.  we might run the live daemon off the main checkout, but we do a lot of dev on worktrees and we need to be able to run a sessions renderer off a worktree.  At the same time, I believe we reserve something like 1gb of memory for each daemon right now and doing this naively would be a lot of duplicate disk io and other resource usage (potentially)
>
> Those are the two goals, which are related but separate.

## The constraints

> - build from primitives that are generally useful.  we want to build the functionality out of primitives that themselves have applicability for multiple use cases.  I dont' care if the use case has no consumers and will not have consumers for 10 years.  it's potential consumers we are looking at, because it's hard to be a consumer of something that doens't exist yet.  no consumers is expected and not in itself any reason not to build something.  iphone had very few users when they decided to bet the company on it
> - data flow not control flow.  we don't have conditional code paths to maintain.  we have different code paths, but they're decided based on data rather than inline checking of conditions
> - generally compliant with /laws:code

## Later rulings

On how the goals are built:

> First of all, what exists isn't how it needs to work.  We aren't going to be decoding anything from any rendered ANSI.  That's not acceptable.  I hope this sets the tone going forward, as does the rest of this message.  We build based on the laws, because it's the ONLY thing that has gotten us this far.

On the payload:

> metrics, activity, and session: these become part of the payload.  Full stop.  Now I don't know exactly what this means but hopefully you can explain to me what the payload is, and how these currently travel outsdie of it.  To me this is immaterial to whether we do build a session stream.  There might be more than the payload, but I feel the payload should contain the data.

On what conclusions rest on:

> 'My config' is not a baseline by which to draw conclusions.  the supported API is where we draw conclusions.  file and shell are the primary expansion points for users who want to get something into their bar.

On the order of work:

> Let's get the basics correct.  We won't build anything but an ansi renderer until we have the wire format correct.  And when we do, the other stuff will drop out naturally.

On clicks:

> About clicks: clicks must be isolated in some way.  I expect this will involve potentially significant changes to the url handler.  If I don't see this I will be suspicious that we're sweeping real concerns under the rug.  Again, not acceptable.  Let's build something excellent, ok?  I'm excited! :D

On scope of the dev work:

> the dev daemon work encompasses:
> - potentially splitting the daemon into 2 parts, one to gather facts, one to draw
> - allows us to iterate on the drawing

On a richer browser, from his question:

> Would this allow us to eventually have richer renderers for surfaces that support it?  speciifcally the browser?

On what may go:

> We can remove features that aren't aligned with our goals as well.

On handling the two goals:

> Let's think about the two separate design goals here and handle them one at a time.

On what clicks are:

> As mentioned, we can cut functionality that we need to.  Then we can reimplement it later in a more laws aligned way.  I think that makes sense to ensure clicks are pure.  a Click could write an event to a queue or something that gets picked up downstream somewhere.  the implementation isn't important, the fact that we can drop the worst offenders is

> set-state and set-config should be pure.  they shouldn't be flipping switches either.  they should be dropping an event or some other approved/laws compliant way to trigger a downstream effect.  it sounds like some of this violates no-ambient-temporal-coupling

> clicks are one way things happen, timers are another.  webhooks might be another one some day.  shouldn't matter.

On paths:

> absolute file paths come out of the undo history, full stop.  every path is prefixed by an isolated state dir.

On there being no dev renderer:

> there IS no such thing as a 'dev draw'.  We draw.  that's it.  we can isolate paths, we can point things at the other renderer/daemon, but it's just a daemona and it's just drawing.  if we have a dev mode, it's because it's instrumented, not because it intrinisically performs a subset of actions compared to any other renderer

On what the primitive is:

> Limiting the list of allowed verbs is the wrong perspective at its core.  That's a dev mode toggle.  And that's not what I'm looking for, I'm looking for an isolated daemon.  That's what the primitive is and that's where we are going.

On Draw:

> Draw should not be writing anything.  it should be Drawing.

On the shape:

> To me it sounds like Gather is a single process, And Events->Apply->Draw is a separate process (or multiple)

> Clicks contain an address, it could be a subscriber name, that controls routing.

> There is no 'side surface'.

> "Claude Code's request gets one answer, so which renderer's frame goes back?" The one that answers claude code's client

On links:

> 'Config-authored' the template fn should mint. it lives in the renderer.  maybe a new template fn.  it's incredible unlikely any user will ever try to write one of these by hand

> 'Doctor probe' doctor must change to use the link minter

> 'Install test URL' does not seem very useful

On restarting:

> Not restarting claude code was never a hard requirement

On browsers:

> Note: all modern browsers are truecolor depth

On a floating window, for the record:

> For the record i love that idea and if it could be attached to the iterm2 window it would be perfect.  i will def use it for something at some point
