# Feedback on the layered test plan

From Brandon, on `docs/layered-test-plan-review.md`. Verbatim.

- ### The four layers

30 end-to-end tests is too many.  You can have 5.  Each test may carry 1 assertion. Any additional assertions in an end to end test MUST be signed off by me personally.  Any test that boots the existing daemon is an end to end test, not an integration test.  If you do not plan and implement work to refactor the daemon into smaller pieces and design fakes/mocks for this purpose, you will have failed categorically.

**Contract and smoke.**  - currently failing

The rest is correct.
