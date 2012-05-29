/* -*- Mode: JavaScript; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Contributor(s):
 *  Shane Caraveo <scaraveo@mozilla.com>
 *
 * Utility methods for dealing with service manifests.
 */

/** Helper function to detect "development mode",
 * which is set with the social.provider.devmode pref.
 *
 * When "devmode" is set, service URLs can be served
 * domains other than the manifest's origin.
 */ 
function isDevMode() {
  prefBranch = Services.prefs.getBranch("social.provider.").QueryInterface(Ci.nsIPrefBranch2);
  let enable_dev = false;
  try {
    enable_dev = prefBranch.getBoolPref("devmode");
  } catch(e) {}
  return enable_dev;
}

/**
 * testSafebrowsing
 *
 * given a url, see if it is in our malware/phishing lists.
 * Returns immediately, calling the callback when a result is known.
 * Callback gets one param, the result which will be non-zero
 * if the url is a problem.
 *
 * @param url string
 * @param callback function
 */
function testSafebrowsing(aUrl, aCallback) {
  // callback gets zero if the url is not found
  // pills.ind.in produces a positive hit for a bad site
  // http://www.google.com/safebrowsing/diagnostic?site=pills.ind.in/
  // result is non-zero if the url is in the malware or phising lists
  let uri = Services.io.newURI(aUrl, null, null);
  var dbservice = Cc["@mozilla.org/url-classifier/dbservice;1"]
                      .getService(Ci.nsIUrlClassifierDBService);
  var handler = {
    onClassifyComplete: function(result) {
      aCallback(result);
    }
  }
  var classifier = dbservice.QueryInterface(Ci.nsIURIClassifier);
  var result = classifier.classify(uri, handler);
  if (!result) {
    // the callback will not be called back, do it ourselves
    aCallback(0);
  }
}


/**
 * getDefaultProviders
 *
 * look into our addon/feature dir and see if we have any builtin providers to install
 */

/// XXX should be called from UI side of things?
/// XXX instead a method with array of files to load?

function getDefaultProviders() {
  var URIs = [];
  try {
    // figure out our installPath
    let res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    let installURI = Services.io.newURI("resource://socialdev/", null, null);
    let installPath = res.resolveURI(installURI);
    let installFile = Services.io.newURI(installPath, null, null);
    try {
      installFile = installFile.QueryInterface(Components.interfaces.nsIJARURI);
    } catch (ex) {} //not a jar file

    // load all prefs in defaults/preferences into a sandbox that has
    // a pref function
    let resURI = Services.io.newURI("resource://socialdev/providers", null, null);
    // If we're a XPI, load from the jar file
    if (installFile.JARFile) {
      let fileHandler = Components.classes["@mozilla.org/network/protocol;1?name=file"].
                  getService(Components.interfaces.nsIFileProtocolHandler);
      let fileName = fileHandler.getFileFromURLSpec(installFile.JARFile.spec);
      let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].
                      createInstance(Ci.nsIZipReader);
      try {
        zipReader.open(fileName);
        let entries = zipReader.findEntries("providers/*");
        while (entries.hasMore()) {
          var entryName = resURI.resolve(entries.getNext());
          if (entryName.indexOf("app.manifest") >= 0)
            URIs.push(entryName);
        }
      }
      finally {
        zipReader.close();
      }
    }
    else {
      let fURI = resURI.QueryInterface(Components.interfaces.nsIFileURL).file;

      var entries = fURI.directoryEntries;
      while (entries.hasMoreElements()) {
        var entry = entries.getNext();
        entry.QueryInterface(Components.interfaces.nsIFile);
        if (entry.leafName.length > 0 && entry.leafName[0] != '.') {
          URIs.push(resURI.resolve("providers/"+entry.leafName+"/app.manifest"));
        }
      }
    }
    //dump(JSON.stringify(URIs)+"\n");
  } catch(e) {
    Cu.reportError(e);
  }
  return URIs
}


/* Utility function: returns the host:port of
 * of a URI, or simply the host, if no port
 * is provided.  If the URI cannot be parsed,
 * or is a resource: URI, returns the input
 * URI text. */
function normalizeOriginPort(aURL) {
  try {
    let uri = Services.io.newURI(aURL, null, null);
    if (uri.scheme == 'resource') return aURL;
    return uri.hostPort;
  }
  catch(e) {
    Cu.reportError(e);
  }
  return aURL;
}


/**
 * manifestRegistry is our internal api for registering manifest files that
   contain data for various services.   It interacts with ManifestDB to
   store a list of service manifests, keyed on domain.
 */
function ManifestRegistry() {
  this._prefBranch = Services.prefs.getBranch("social.provider.").QueryInterface(Ci.nsIPrefBranch2);
  Services.obs.addObserver(this, "document-element-inserted", true);
  // TODO: should observe DOMLinkAdded instead of document-element-inserted

  // load the builtin providers if any
  let URIs = getDefaultProviders();
  for each(let uri in URIs) {
    this.loadManifest(null, uri, true);
  }
}

const manifestRegistryClassID = Components.ID("{8d764216-d779-214f-8da0-80e211d759eb}");
const manifestRegistryCID = "@mozilla.org/manifestRegistry;1";

ManifestRegistry.prototype = {
  classID: manifestRegistryClassID,
  contractID: manifestRegistryCID,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupportsWeakReference, Ci.nsIObserver]),

  askUserInstall: function(aWindow, aCallback, location) {
    let origin = normalizeOriginPort(location);
    // BUG 732263 remember if the user says no, use that as a check in
    // discoverActivity so we bypass a lot of work.
    let nId = "manifest-ask-install";
    let nBox = aWindow.gBrowser.getNotificationBox();
    let notification = nBox.getNotificationWithValue(nId);

    // Check that we aren't already displaying our notification
    if (!notification) {
      let self = this;
      let message = "This site supports additional functionality for Firefox, would you like to install it?";

      buttons = [{
        label: "Yes",
        accessKey: null,
        callback: function () {
          aWindow.setTimeout(function () {
            aCallback();
          }, 0);
        }
      },
      {
        label: "Don't ask again",
        accessKey: 'd',
        callback: function() {
          self._prefBranch.setBoolPref(origin+".ignore", true);
        }
      }];
      nBox.appendNotification(message, nId, null,
                nBox.PRIORITY_INFO_MEDIUM,
                buttons);
    }
  },

  /**
   * validateManifest
   *
   * Given the manifest data, create a clean version of the manifest.  Ensure
   * any URLs are same-origin (proto+host+port).  If the manifest is a builtin,
   * URLs must either be resource or same-origin resolved against the manifest
   * origin. We ignore any manifest entries that are not supported.
   *
   * @param location   string      string version of manifest location
   * @param manifest   json-object raw manifest data
   * @returns manifest json-object a cleaned version of the manifest
   */
  validateManifest: function manifestRegistry_validateManifest(location, rawManifest) {
    // anything in URLEntries will require same-origin policy, though we
    // special-case iconURL to allow icons from CDN
    let URLEntries = ['iconURL', 'workerURL', 'sidebarURL'];

    // only items in validEntries will move into our cleaned manifest
    let validEntries = ['name'].concat(URLEntries);

    // Is this a "built-in" service?
    let builtin = location.indexOf("resource:") == 0;
    if (builtin) {
      // builtin manifests may have a couple other entries
      validEntries = validEntries.concat('origin', 'contentPatchPath');
    }

    // store the location we got the manifest from and the origin.
    let manifest = {
      location: location
    };
    for (var k in rawManifest.services.social) {
      if (validEntries.indexOf(k) >= 0) manifest[k] = rawManifest.services.social[k];
    }
    // we've saved original location in manifest above, switch our location
    // temporarily so we can correctly resolve urls for our builtins.  We
    // still validate the origin defined in a builtin manifest below.
    if (builtin && manifest.origin) {
      location = manifest.origin;
    }

    // resolve all URLEntries against the manifest location.
    let basePathURI = Services.io.newURI(location, null, null);
    // full proto+host+port origin for resolving same-origin urls
    manifest.origin = basePathURI.prePath;
    for each(let k in URLEntries) {
      
      if (!manifest[k]) continue;
      
      // shortcut - resource:// URIs don't get same-origin checks.
      if (builtin && manifest[k].indexOf("resource:") == 0) continue;
      
      // resolve the url to the basepath to handle relative urls, then verify
      // same-origin, we'll let iconURL be on a different origin
      let url = basePathURI.resolve(manifest[k]);
      
      if (k != 'iconURL' && url.indexOf(manifest.origin) != 0) {
        throw new Error("manifest URL origin mismatch " +manifest.origin+ " != " + manifest[k] +"\n")
      }
      manifest[k] = url; // store the resolved version
    }
    return manifest;
  },

  importManifest: function manifestRegistry_importManifest(aDocument, location, rawManifest, systemInstall, callback) {
    //Services.console.logStringMessage("got manifest "+JSON.stringify(manifest));
    let manifest = this.validateManifest(location, rawManifest);

    // we want automatic updates to the manifest entry if we change our
    // builtin manifest files.   We also want to allow the "real" provider
    // to overwrite our builtin manifest, however we NEVER want a builtin
    // manifest to overwrite something installed from the "real" provider
    function installManifest() {
      ManifestDB.get(manifest.origin, function(key, item) {
        // dont overwrite a non-resource entry with a resource entry.
        if (item && manifest.location.indexOf('resource:') == 0 &&
                    item.location.indexOf('resource:') != 0) {
          // being passed a builtin and existing not builtin - ignore.
          if (callback) {
            callback(false);
          }
          return;
        }
        // dont overwrite enabled, but first install is always enabled
        manifest.enabled = item ? item.enabled : true;
        ManifestDB.put(manifest.origin, manifest);
        registry().register(manifest);
        if (callback) {
          callback(true);
        }
      });
    }

    if (systemInstall) {
      // user approval has already been granted, or this is an automatic operation
      installManifest();
    }
    else {
      // we need to ask the user for confirmation:
      var xulWindow = aDocument.defaultView.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIWebNavigation)
                     .QueryInterface(Ci.nsIDocShellTreeItem)
                     .rootTreeItem
                     .QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindow);
      this.askUserInstall(xulWindow, function() {
        installManifest();

        // user requested install, lets make sure we enable after the install.
        // This is especially important on first time install.

        registry().enabled = true;
        let prefBranch = Services.prefs.getBranch("social.provider.").QueryInterface(Ci.nsIPrefBranch2);
        prefBranch.setBoolPref("visible", true);
        Services.obs.notifyObservers(null,
                                 "social-browsing-enabled",
                                 registry().currentProvider.origin);
      }, location)
      return;
    }
  },

  _checkManifestSecurity: function(channel) {
    // this comes from https://developer.mozilla.org/En/How_to_check_the_security_state_of_an_XMLHTTPRequest_over_SSL
    // although we are more picky about things (ie, secInfo MUST be a nsITransportSecurityInfo and a nsISSLStatusProvider)
    let secInfo = channel.securityInfo;
    if (!(secInfo instanceof Ci.nsITransportSecurityInfo) || ((secInfo.securityState & Ci.nsIWebProgressListener.STATE_IS_SECURE) != Ci.nsIWebProgressListener.STATE_IS_SECURE)) {
      Cu.reportError("Attempt to load social service from insecure location (manifest securityState is not secure)");
      return false;
    }
    if (!(secInfo instanceof Ci.nsISSLStatusProvider)) {
      Cu.reportError("Attempt to load social service from insecure location (manifest host has no SSLStatusProvider)");
      return false;
    }
    let cert = secInfo.QueryInterface(Ci.nsISSLStatusProvider)
               .SSLStatus.QueryInterface(Ci.nsISSLStatus).serverCert;
    let verificationResult = cert.verifyForUsage(Ci.nsIX509Cert.CERT_USAGE_SSLServer);
    if (verificationResult != Ci.nsIX509Cert.VERIFIED_OK) {
      Cu.reportError("Attempt to load social service from insecure location (SSL status of the manifest host is invalid)");
      return false;
    }
    return true;
  },

  loadManifest: function manifestRegistry_loadManifest(aDocument, url, systemInstall, callback) {
    // test any manifest against safebrowsing
    let self = this;
    testSafebrowsing(url, function(result) {
      if (result != 0) {
        Cu.reportError("Attempt to load social service from unsafe location (safebrowsing result: ["+result+"] "+url + ")");
        if (callback) callback(false);
        return;
      }

      // BUG 732264 error and edge case handling
      let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIXMLHttpRequest);
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function(aEvt) {
        if (xhr.readyState == 4) {
          if (xhr.status == 200 || xhr.status == 0) {
            
            // We implicitly trust resource:// manifest origins.
            let needSecureManifest = !isDevMode() && url.indexOf("resource://") != 0;
            if (needSecureManifest && !self._checkManifestSecurity(xhr.channel)) {
              if (callback) callback(false);
              return;
            }
            try {
              self.importManifest(aDocument, url, JSON.parse(xhr.responseText), systemInstall, callback);
            }
            catch(e) {
              Cu.reportError("Error while loading social service manifest from "+url+": "+e);
              if (callback) callback(false);
            }
          }
          else {
            Cu.reportError("Error while loading social service manifest from " + url + ": status "+xhr.status);
          }
        }
      };
      xhr.send(null);
    });
  },

  discoverManifest: function manifestRegistry_discoverManifest(aDocument, aData) {
    // BUG 732266 this is probably heavy weight, is there a better way to watch for
    // links in documents?
    // https://developer.mozilla.org/En/Listening_to_events_in_Firefox_extensions
    // DOMLinkAdded event

    // TODO determine whether or not we actually want to load this
    // manifest.
    // 1. is it already loaded, skip it, we'll check it for updates another
    //    way
    // 2. does the user have a login for the site, if so, load it
    // 3. does the fecency for the site warrent loading the manifest and
    //    offering to the user?
    try {
      if (this._prefBranch.getBoolPref(aDocument.defaultView.location.host+".ignore")) {
        return;
      }
    } catch(e) {}

    // we need a way to test against local non-http servers on occasion
    let allow_http = false;
    try {
      allow_http = this._prefBranch.getBoolPref("allow_http");
    } catch(e) {}

    let self = this;
    let links = aDocument.getElementsByTagName('link');
    for (let index=0; index < links.length; index++) {
      let link = links[index];
      if (link.getAttribute('rel') == 'manifest' &&
          link.getAttribute('type') == 'text/json') {
        //Services.console.logStringMessage("found manifest url "+link.getAttribute('href'));
        let baseUrl = aDocument.defaultView.location.href;
        let url = Services.io.newURI(baseUrl, null, null).resolve(link.getAttribute('href'));
        let resolved = Services.io.newURI(url, null, null);
        // we only allow remote manifest files loaded from https
        if (!allow_http && resolved.scheme != "https")
          return;
        //Services.console.logStringMessage("base "+baseUrl+" resolved to "+url);
        ManifestDB.get(url, function(key, item) {
          if (!item) {
            self.loadManifest(aDocument, url);
          }
        });
      }
    }
  },

  /**
   * observer
   *
   * reset our mediators if an app is installed or uninstalled
   */
  observe: function manifestRegistry_observe(aSubject, aTopic, aData) {
    if (aTopic == "document-element-inserted") {
      if (!aSubject.defaultView)
        return;
      //Services.console.logStringMessage("new document "+aSubject.defaultView.location);
      this.discoverManifest(aSubject, aData);
      return;
    }
  }
};
