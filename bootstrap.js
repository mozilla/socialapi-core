/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This bootstrap file uses chrome.manifest to dynamically register
 * chrome/skin/locale URIs, allowing an overlay based addon to easily
 * become restartless.  It is based on work by Dave Townsend at
 * https://github.com/Mossop/WebAppTabs/
 *
 * One limitation is that addons cannot use custom XPCOM interfaces (ie. if you
 * have an IDL file, this wont work). XPCOM registration beyond basic stuff
 * has not been tested.
 */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");

// bootstrap functions

function install(aParams, aReason) {
}

function startup(aParams, aReason) {
  let res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  res.setSubstitution("socialapi", aParams.resourceURI);
  Services.obs.notifyObservers(null, "socialapi-core-startup", null);
}

function shutdown(aParams, aReason) {
  // We need to shutdown the typedstorage database else we assert in
  // debug builds at shutdown.
  let tmp = {};
  Cu.import("resource://socialapi/modules/manifestDB.jsm", tmp);
  tmp.ManifestDB.close();

  // Don't need to clean anything else up if the application is shutting down
  if (aReason == APP_SHUTDOWN) {
    return;
  }
  // Unload and remove the overlay manager
  OverlayManager.unload(aParams);
}

function uninstall(aParams, aReason) {
}
