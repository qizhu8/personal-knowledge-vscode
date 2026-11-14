import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { SubscriptionTransportEndpoint, SubscriptionTransportFetch } from "../subscription-transport-contracts.js";
import { transportError } from "./subscription-transport-protocol.js";

function literalAddress(address: string) {
  if (!isIP(address)) transportError("ACCESS_DENIED", "A host-issued literal socket address is required.");
  const parsed = ipaddr.process(address);
  if (!["unicast", "loopback"].includes(parsed.range())) transportError("ACCESS_DENIED", "Private, link-local, reserved and metadata socket addresses are forbidden.");
  return parsed.range();
}
export function transportEndpoint(endpoint: SubscriptionTransportEndpoint): URL {
  let url: URL;
  try { url = new URL(endpoint.controlUrl); } catch { transportError("ACCESS_DENIED", "Invalid host-issued endpoint."); }
  const range = literalAddress(endpoint.connectAddress);
  if (!["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && range !== "loopback"
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !endpoint.bindingId || !endpoint.secretRef || !endpoint.publisherPublicKey
    || !endpoint.transferPorts.length || endpoint.transferPorts.length > 1024
    || endpoint.transferPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
    transportError("ACCESS_DENIED", "Unsafe or incomplete host-issued endpoint configuration.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (range === "loopback" && hostname !== endpoint.connectAddress) transportError("ACCESS_DENIED", "Loopback endpoint must be an exact literal address.");
  if (isIP(hostname) && hostname !== endpoint.connectAddress) transportError("ACCESS_DENIED", "Endpoint socket address mismatch.");
  return url;
}
export function transportBroker(value: string, endpoint: SubscriptionTransportEndpoint): URL {
  const control = transportEndpoint(endpoint);
  let broker: URL;
  try { broker = new URL(value); } catch { transportError("ACCESS_DENIED", "Invalid transfer broker."); }
  if (broker.protocol !== control.protocol || broker.hostname !== control.hostname
    || broker.username || broker.password || broker.search || broker.hash || broker.pathname !== "/"
    || broker.port === control.port || !endpoint.transferPorts.includes(Number(broker.port))) {
    transportError("ACCESS_DENIED", "Remote transfer grant cannot authorize a new endpoint.");
  }
  broker.pathname = "/sync/bundle";
  return broker;
}
/** No global fetch, redirects, proxy environment, DNS discovery, broker defaults or MQTT auto-connect. */
export const subscriptionTransportSocketFetch: SubscriptionTransportFetch = async (url, method, headers, signal, address) => {
  literalAddress(address);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method, headers, signal, agent: false, maxHeaderSize: 16_384,
      lookup: (_host, _options, callback) => callback(null, address, isIP(address)),
    }, res => {
      const responseHeaders: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(res.headers)) responseHeaders[key] = Array.isArray(value) ? value.join(",") : value;
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        reject(new Error(`Gateway returned HTTP ${res.statusCode ?? 0}.`));
        return;
      }
      resolve({ status: res.statusCode, headers: responseHeaders, body: res });
    });
    req.once("error", reject);
    req.end();
  });
};
