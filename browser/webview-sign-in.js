"use strict";
const form = document.querySelector("form");
const input = document.getElementById("pkm-token");
const button = form.querySelector("button");
const error = form.querySelector("[role=alert]");
form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/webview/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: input.value, remember: document.getElementById("pkm-remember").checked }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "Sign-in failed.");
    location.replace("/webview/");
  } catch (failure) {
    error.textContent = failure.message;
    input.focus();
  } finally {
    input.value = "";
    button.disabled = false;
  }
});
