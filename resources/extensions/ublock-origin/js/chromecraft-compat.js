/*******************************************************************************

    Chromecraft compatibility bridge for uBlock Origin on Electron.

    Electron intentionally implements only a subset of the Chrome extension
    API. uBlock Origin's background module eagerly wraps several UI and privacy
    APIs before its network engine starts, even when those APIs are not needed
    for filtering. This bridge supplies conservative no-op fallbacks for the
    absent APIs. It does not implement request filtering; uBlock Origin remains
    the sole owner of chrome.webRequest.

*/

((nativeChrome) => {
    'use strict';

    const callLastFunction = function(...args) {
        const callback = args.at(-1);
        if ( typeof callback === 'function' ) {
            queueMicrotask(( ) => callback());
        }
    };
    const event = ( ) => ({
        addListener: ( ) => undefined,
        hasListener: ( ) => false,
        removeListener: ( ) => undefined,
    });
    const setting = ( ) => ({
        clear: callLastFunction,
        get: function(...args) {
            const callback = args.at(-1);
            if ( typeof callback === 'function' ) {
                queueMicrotask(( ) => callback({ value: undefined, levelOfControl: 'not_controllable' }));
            }
        },
        set: callLastFunction,
    });
    const withFallbacks = (nativeValue, fallbacks) => new Proxy(nativeValue ?? {}, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            return value === undefined ? fallbacks[property] : value;
        },
    });

    const fallbackTabs = {
        executeScript: callLastFunction,
        insertCSS: callLastFunction,
        onActivated: event(),
        onRemoved: event(),
        onUpdated: event(),
        remove: callLastFunction,
        removeCSS: callLastFunction,
        sendMessage: callLastFunction,
        update: callLastFunction,
    };
    const fallbacks = {
        alarms: {
            clear: callLastFunction,
            clearAll: callLastFunction,
            create: callLastFunction,
            get: callLastFunction,
            getAll: function(callback) { queueMicrotask(( ) => callback([])); },
            onAlarm: event(),
        },
        browserAction: {
            onClicked: event(),
            setBadgeBackgroundColor: callLastFunction,
            setBadgeText: callLastFunction,
            setBadgeTextColor: callLastFunction,
            setIcon: callLastFunction,
            setTitle: callLastFunction,
        },
        contextMenus: {
            create: function(_details, callback) {
                if ( typeof callback === 'function' ) queueMicrotask(callback);
                return 'chromecraft-noop-menu';
            },
            onClicked: event(),
            remove: callLastFunction,
            removeAll: callLastFunction,
        },
        privacy: {
            network: {
                networkPredictionEnabled: setting(),
                webRTCIPHandlingPolicy: setting(),
            },
            websites: {
                hyperlinkAuditingEnabled: setting(),
            },
        },
        webNavigation: {
            getFrame: function(_details, callback) { queueMicrotask(( ) => callback(null)); },
            getAllFrames: function(_details, callback) { queueMicrotask(( ) => callback([])); },
            onCommitted: event(),
            onCreatedNavigationTarget: event(),
        },
        windows: {
            create: callLastFunction,
            get: callLastFunction,
            getCurrent: callLastFunction,
            onFocusChanged: event(),
            onRemoved: event(),
            update: callLastFunction,
        },
    };

    const compatibilityChrome = new Proxy(nativeChrome, {
        get(target, property) {
            if ( property === 'tabs' ) {
                return withFallbacks(Reflect.get(target, property, target), fallbackTabs);
            }
            const value = Reflect.get(target, property, target);
            return value === undefined ? fallbacks[property] : value;
        },
    });

    globalThis.browser = compatibilityChrome;
    try {
        globalThis.chrome = compatibilityChrome;
    } catch {
    }
})(globalThis.chrome);
