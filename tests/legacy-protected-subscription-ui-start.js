document.getElementById("fixture-quit").addEventListener("click", () => ask("fixtureClose"));
document.getElementById("membership-recover").addEventListener("click", () => ask("membershipRecover"));
document.getElementById("membership-cancel").addEventListener("click", () => ask("membershipCancel"));
ask("subscriptionState");
