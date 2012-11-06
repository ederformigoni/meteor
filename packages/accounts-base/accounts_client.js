(function () {

  // This is reactive.
  Meteor.userId = function () {
    return Meteor.default_connection.userId();
  };

  var loggingIn = false;
  var loggingInListeners = new Meteor.deps._ContextSet;
  var setLoggingIn = function (x) {
    loggingIn = x;
    loggingInListeners.invalidateAll();
  };
  Meteor.loggingIn = function () {
    loggingInListeners.addCurrentContext();
    return loggingIn;
  };

  // This calls userId, which is reactive.
  Meteor.user = function () {
    var userId = Meteor.userId();
    if (!userId)
      return null;
    var user = Meteor.users.findOne(userId);
    if (user) return user;

    // For some reason this user has no published fields (and thus is considered
    // to not exist in minimongo). Return a minimal object.
    return {_id: userId};
  };

  // Call a login method on the server.
  //
  // A login method is a method which on success calls `this.setUserId(id)` on
  // the server and returns an object with fields 'id' (containing the user id)
  // and 'token' (containing a resume token).
  //
  // This function takes care of:
  //   - Updating the Meteor.loggingIn() reactive data source
  //   - Calling the method in 'wait' mode
  //   - On success, saving the resume token to localStorage
  //   - On success, calling Meteor.default_connection.setUserId()
  //   - Setting up an onReconnect handler which logs in with
  //     the resume token
  //
  // Options:
  // - methodName: The method to call (default 'login')
  // - methodArguments: The arguments for the method
  // - acceptResult: If provided, will be called with the result of the method.
  //                 If it throws, the client will not be logged in (and its
  //                 error will be passed to the callback).
  // - userCallback: Will be called with no arguments once the user is fully
  //                 logged in, or with the error on error.
  Accounts.callLoginMethod = function (options) {
    options = _.extend({
      methodName: 'login',
      methodArguments: [],
      acceptResult: function () { },
      userCallback: function () { }
    }, options);

    var reconnected = false;
    var calledUserCallback = false;

    // We want to set up onReconnect as soon as we get a result token back from
    // the server, without having to wait for subscriptions to rerun. This is
    // because if we disconnect and reconnect between getting the result and
    // getting the results of subscription rerun, we WILL NOT re-send this
    // method (because we never re-send methods whose results we've received)
    // but we WILL call loggedInAndDataReadyCallback at "reconnect quiesce"
    // time. This will lead to _makeClientLoggedIn(result.id) even though we
    // haven't actually sent a login method!
    //
    // But by making sure that we send this "resume" login in that case (and
    // calling _makeClientLoggedOut if it fails), we'll end up with an accurate
    // client-side userId. (It's important that livedata_connection guarantees
    // that the "reconnect quiesce"-time call to loggedInAndDataReadyCallback
    // will occur before the callback from the resume login call.)
    var justResultCallback = function (err, result) {
      if (err || !result.token) {
        Meteor.default_connection.onReconnect = null;
      } else {
        Meteor.default_connection.onReconnect = function() {
          reconnected = true;
          Accounts.callLoginMethod({
            methodArguments: [{resume: result.token}],
            userCallback: function (error) {
              if (error) {
                Accounts._makeClientLoggedOut();
              }
              if (!calledUserCallback) {
                calledUserCallback = true;
                options.userCallback(error);
              }
            }});
        };
      }
    };

    // This callback is called once the local cache of the current-user
    // subscription (and all subscriptions, in fact) are guaranteed to be up to
    // date.
    var loggedInAndDataReadyCallback = function (error, result) {
      setLoggingIn(false);
      if (error || !result) {
        error = error || new Error(
          "No result from call to " + options.methodName);
        options.userCallback(error);
        return;
      }
      try {
        options.acceptResult(result);
      } catch (e) {
        options.userCallback(e);
        return;
      }

      // Make the client logged in. (The user data should already be loaded!)
      Accounts._makeClientLoggedIn(result.id, result.token);
      options.userCallback();
    };

    setLoggingIn(true);
    Meteor.apply(
      options.methodName,
      options.methodArguments,
      {wait: true, justResultCallback: justResultCallback},
      loggedInAndDataReadyCallback);
  };

  Accounts._makeClientLoggedOut = function() {
    Accounts._unstoreLoginToken();
    Meteor.default_connection.setUserId(null);
    Meteor.default_connection.onReconnect = null;
  };

  Accounts._makeClientLoggedIn = function(userId, token) {
    Accounts._storeLoginToken(userId, token);
    Meteor.default_connection.setUserId(userId);
  };

  Meteor.logout = function (callback) {
    Meteor.apply('logout', [], {wait: true}, function(error, result) {
      if (error) {
        callback && callback(error);
      } else {
        Accounts._makeClientLoggedOut();
        callback && callback();
      }
    });
  };

  // If we're using Handlebars, register the {{currentUser}} and
  // {{loggingIn}} global helpers.
  if (typeof Handlebars !== 'undefined') {
    Handlebars.registerHelper('currentUser', function () {
      return Meteor.user();
    });
    Handlebars.registerHelper('loggingIn', function () {
      return Meteor.loggingIn();
    });
  }

  // XXX this can be simplified if we merge in
  // https://github.com/meteor/meteor/pull/273
  var loginServicesConfigured = false;
  var loginServicesConfiguredListeners = new Meteor.deps._ContextSet;
  Meteor.subscribe("meteor.loginServiceConfiguration", function () {
    loginServicesConfigured = true;
    loginServicesConfiguredListeners.invalidateAll();
  });

  // A reactive function returning whether the
  // loginServiceConfiguration subscription is ready. Used by
  // accounts-ui to hide the login button until we have all the
  // configuration loaded
  Accounts.loginServicesConfigured = function () {
    if (loginServicesConfigured)
      return true;

    // not yet complete, save the context for invalidation once we are.
    loginServicesConfiguredListeners.addCurrentContext();
    return false;
  };
})();
