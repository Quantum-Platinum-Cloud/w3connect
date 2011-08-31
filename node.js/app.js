
/**
 * Module dependencies.
 */

var express = require('express');
var everyauth = require('everyauth'),
    EventEmitter = require('events').EventEmitter;
var imports = require("./imports.js"),
    twitter = require("./twitter.js");;


form = require("express-form"),
filter = form.filter,
validate = form.validate;

var fs = require('fs');

var app = module.exports = express.createServer({key: fs.readFileSync('/etc/ssl/private/wildcard.w3.org.key'), cert: fs.readFileSync('/etc/ssl/certs/cert-w3.org.crt')});
var emitter = new EventEmitter();

var mongoose = require('mongoose'),
db = mongoose.connect('mongodb://localhost/tpac');

var People = require('./model.js').People(db);

var Organization = require('./model.js').Organization(db);
var Place = require('./model.js').Place(db);
var TaxiFromAirport = require('./model.js').TaxiFromAirport(db);
var TaxiToAirport = require('./model.js').TaxiToAirport(db);
var TwitterSettings = require('./model.js').TwitterSettings(db);




// Authentication 
// Session Store
var SessionMongoose = require("session-mongoose");
var mongooseSessionStore = new SessionMongoose({
    url: "mongodb://localhost/session",
    interval: 120000 // expiration check worker run interval in millisec (default: 60000)
});

everyauth.everymodule.findUserById( function (userId, callback) {
  // is there anyone in the db yet? 
    People.count({}, function(err, count) {
	if (!count) {
	    // No one in the db, we create a mock user to allow for import
	    callback(err, {'login': userId, 'given': 'Admin', 'family': 'Istrator'});
	} else {
	    People.findOne({login: userId}, callback);
	}
    });
});

// Adapted from everyauth ldap module
everyauth.password
  .getLoginPath('/login')
  .postLoginPath('/login') // Uri path that your login form POSTs to
  .loginView('login.ejs')
  .registerView('index.ejs') // @@@ need fixing
  .loginSuccessRedirect('/')
  /*.respondToLoginSucceed( function (res, user, data) {
    if (user) {
      res.writeHead(303, {'Location': data.session.redirectTo});
      res.end();
    }   
  })*/
  .authenticate( function (login, password) {
    var promise = this.Promise();  
    var errors = [];
      if (!login) errors.push('Missing login');
      if (!password) errors.push('Missing password');
      if (errors.length) return errors;
      var ldap = require('./ldapauth');
      // modified version of ldapauth that takes an additional scheme parameter available from https://github.com/dontcallmedom/node-ldapauth
      ldap.authenticate('ldaps','directory.w3.org',636,'uid=' + login + ',ou=people,dc=w3,dc=org', password, function(err, result) {
        if (err) {
          return promise.fail(err);
        }
	if (result === false) {
          errors = ['Login failed.'];
          return promise.fulfill(errors);
	} else {
          var user = {id: login};
	  // We'll use this to get data from WBS when importing registrants list
	  app.set('w3c_auth', new Buffer(login + ':' + password).toString('base64')); 	  
          return promise.fulfill(user);	    
	}
      });
      return promise;
  })
  .getRegisterPath('/')
  .postRegisterPath('/')
  .registerUser(function() {
      return null;
   });


// Configuration

app.configure(function(){
  emitter.setMaxListeners(0);
  app.use(express.logger());
  app.set('views', __dirname + '/views');
  app.set('view engine', 'ejs');
  app.set('port', 3000);
  app.use(express.bodyParser());
  app.use(express.static(__dirname + '/public', { maxAge: 86400}));
  app.use(express.methodOverride());
 app.use(express.cookieParser()); 
  app.use(express.session({store: mongooseSessionStore, secret:'abc'}));
  app.use(everyauth.middleware());
  // Loading up list of twitter users
  TwitterSettings.findOne(
      {}, 
      function(err, settings) {
	  // No twitter settings
	  if (err || !settings) {
	      console.log("No twitter settings found, won't get updates from Twitter");
	  } else {
	      if (!(settings.username && settings.password && settings.list && settings.list.owner && settings.list.slug)) {
		  console.log("Incomplete twitter settings found, won't get updates from Twitter: " + JSON.stringify(settings));
	      } else {
		  app.set('twitter_auth', new Buffer(settings.username + ':' + settings.password).toString('base64')); 	  
		  if (!settings.ids || !settings.ids.length) {
		      // load a list of users from Twitter
		      twitter.listTwitterIds(
			  settings.list.owner,
			  settings.list.slug,
			  function (ids) {
			      settings.ids = ids;
			      settings.save();
			  });
		  }
	      }
	  }
      });
});

app.configure('test', function(){
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
  //db = mongoose.connect('mongodb://localhost/tpac-test');
});


app.configure('development', function(){
  everyauth.debug = true;
  app.use(express.logger());
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
});

app.configure('production', function(){
  app.use(express.logger());
  app.use(express.errorHandler()); 
  app.set('port', 443);
});



// Routes
// if the _format parameter is set, we override req.params.format
app.post(RegExp(".*"), function(req, res, next) {
    if (req.body && req.body._format) {
	req.outputFormat = req.body._format;
    }
    next();
});

app.error(function(err, req, res, next){
  res.send(err.message, 500);
});


app.get('/', function(req, res){
  // skipped by middleware at this point, need fixing @@@
  People.count({}, function(err, count) {
      if (!count) {
	  // no user, need to import data
	  if (! req.loggedIn) {
	      return res.redirect(everyauth.password.getLoginPath());
	  } else {
	      // Import basic data: people and rooms
	      imports.importUserList(app.set("w3c_auth"), function(success, info, errors) {
		  req.flash("info", "First run, importing registrants list");
		  if (success) success.forEach(function(i) { req.flash('success',i);});
		  if (info) info.forEach(function(i) { req.flash('info',i);});
		  if (errors) errors.forEach(function(i) { req.flash('error',i);});
		  res.render('index');
	      });
	  }
      } else {
	  res.render('index');
      }
  });
});

app.get('/admin/', function(req, res){
    res.render('admin/index');

});

app.post('/admin/', function(req, res){
  if (req.body.peopleUpdate) {
    if (! req.loggedIn) {
      return res.redirect(everyauth.password.getLoginPath());
    } else if (!app.set("w3c_auth")) {
	// in case user logged in a previous session
	// should find how to logout?
	return res.redirect(everyauth.password.getLoginPath());
    }
      imports.importUserList(app.set("w3c_auth"), function(success, info, errors) {
	  if (success) success.forEach(function(i) { req.flash('success',i);});
	  if (info) info.forEach(function(i) { req.flash('info',i);});
	  if (errors) errors.forEach(function(i) { req.flash('error',i);});
          res.render('admin/index');
      });
  } else  if (req.body.placeAdd) {
      var place = new Place();
      place.shortname = req.body.shortname;
      place.name = req.body.name;
      function addPlace(p) {
	  return function(err) { 
                res.render('admin/index', {
                  locals: {
	            placeAddition : p
	          }
                 });
	       };
      };
      place.save(addPlace(place));
  } else if (req.body.placesUpdate) {
   var https = require('https');

   var request = https.get({host: 'dvcs.w3.org', path:'/hg/tpac-web/raw-file/tip/maps/rooms.json'}, function (response) {
     response.setEncoding('utf8');
     var placesJSON = "", placesData;
     response.on('data', function (chunk) {
       placesJSON = placesJSON + chunk;
     });
     response.on('end', function () {
	 Place.find({}).remove();
        placesData = JSON.parse(placesJSON);
	 for (i in placesData) {
	     var p = new Place(placesData[i]);
	     var counter = 0;
	     var addCounter = 0;
	     p.save(function (err) {
		 counter++;
		 if (err) {
		     req.flash('error',err);
		 } else {
		     addCounter++;
		 }
		 if (counter == placesData.length) {
		     res.render('admin/index');
		 }
	     });
	 }
     });
   });
  } else {
    res.render('admin/index', {
      title: 'TPAC Web App Administration'
    });      
  }
});


app.get('/people/:id.:format?', function(req, res, next){
    People.findOne({w3cId: req.params.id}).populate('affiliation', ['w3cId', 'name']).run( function(err, indiv) {
	if (indiv) {
	    switch (req.params.format) {
		// When json, generate suitable data
	    case 'json':
		res.send(indiv);
		break;
	    default:
		res.render('people/indiv.ejs', { locals: { indiv: indiv}});
	    }
	} else {
	    next();
	}
  });  
});

app.get('/locations.:format?', function(req, res) {
  Place.find({}, function (err, places) {
    places.sort(function (a,b) { return (a.name > b.name ? 1 : (b.name > a.name ? -1 : 0));});
    var counter=0;
    for (p in places) {
      People.find({"lastKnownPosition.shortname": places[p].shortname}, ['w3cId', 'given', 'family', 'picture_thumb'],  (function(place) { return function(err, people) {
         counter++;
         place.checkedin = people;
         if (counter==places.length) {	     
          switch (req.params.format) {
          // When json, generate suitable data
           case 'json':
	     res.send(places);
	     break;
           default:
             res.render('locations/index.ejs', { locals: { places: places}});
           }
	 }
      };})(places[p]));
    }		    
  });

});

app.get('/locations/stream', function(req, res) {
    res.setHeader("Content-Type", 'text/event-stream');
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.writeHead(200);
    emitter.on("checkin", function(user, left, entered) {
	res.write("data: " + JSON.stringify({"user": user, "left": left, "entered": entered, "you": (req.user && JSON.stringify(user._id) == JSON.stringify(req.user._id))}) + "\n\n");
    });
    emitter.on("tweet", function(tweet) {
        res.write("event: tweet\n");
	res.write("data: " + JSON.stringify(tweet) + "\n\n");
    });
});

app.get('/locations/:id.:format?', function(req, res) {
    Place.findOne({shortname: req.params.id}, function(err, place) {
    if (place) {
      People.find({"lastKnownPosition.shortname": place.shortname}, ['w3cId', 'given', 'family', 'picture_thumb'], function(err, people) {
	people.sort(function (a,b) { return (a.lastKnownPosition.time > b.lastKnownPosition.time ? 1 : (b.lastKnownPosition.time  > a.lastKnownPosition.time ? -1 : 0));});
        switch (req.params.format) {
	    // When json, generate suitable data
	case 'json':
	    place.checkedin = people;
            res.send(place);
	    break;
	default:
	    res.render('locations/place.ejs', { locals: { place: place, people: people}});
	}
      });
    } else {
       res.render('locations/unknown.ejs', {locals: { shortname: req.params.id}});
   }
  });

});

app.post('/locations/:id.:format?', function(req, res) {
  if (! req.loggedIn) {
    req.session.redirectTo = '/locations/' + req.params.id;
    return res.redirect(everyauth.password.getLoginPath());
  }
    Place.findOne({shortname: req.params.id}, function(err, place) {
    if (place) {
	if (req.body.checkin && req.user) {
	    // the user is already checked in in that place
	    if (req.user.lastKnownPosition.shortname == place.shortname) {
		switch (req.outputFormat) {
		case "json":
		    res.send(JSON.stringify({success: "Already checked in at " + place.name}));
		    break;
		default:
		    req.flash('info', "You’re already checked in at " + place.name);
                    People.find({"lastKnownPosition.shortname": place.shortname}, function(err, people) {
  			res.render('locations/place.ejs', { locals: { place: place, people: people}});
	            });		    
		}
	    } else {
	   var indiv = req.user ;
	    var prevPosition = {shortname: indiv.lastKnownPosition.shortname,
				name: indiv.lastKnownPosition.name,
				time: indiv.lastKnownPosition.time};
	   indiv.lastKnownPosition = {};		      
	   indiv.lastKnownPosition.shortname = place.shortname; 
	   indiv.lastKnownPosition.name = place.name; 
	   indiv.lastKnownPosition.time = Date.now();
	   indiv.save(function(err) {
             req.flash('error',err);
	       if (!err) {
		   emitter.emit("checkin", req.user, prevPosition, place);
	       }
               switch (req.outputFormat) {
                 case 'json':
		   if (!err) { 
                     res.send(JSON.stringify({success: 'Checked in at ' + place.name}));
		   } else {
		     res.send({error: err});
		   }
    	           break;
                 default:
		   if (!err) {
		     req.flash('info', 'Checked in at '  + place.name);
		   } else {
		       req.flash('error', err);
		   }
                   People.find({"lastKnownPosition.shortname": place.shortname}, function(err, people) {
  		     res.render('locations/place.ejs', { locals: { place: place, people: people}});
	           });
	       }
	   });
	    }
	} else {
          switch (req.params.format) {
            case 'json':
              res.send(place);
	      break;
            default:
  	      People.find({"lastKnownPosition.shortname": place.shortname}, function(err, people) {
	      res.render('locations/place.ejs', { locals: { place: place, people: people}});
				 
              });
          }
	    
	}
   } else {
       res.render('locations/unknown.ejs', {locals: { shortname: req.params.id}});
   }
  });

});


app.get('/people.:format?', function (req, res){
  var people = People.find({}, function (err, people) {
    people.sort(function (a,b) { return (a.family > b.family ? 1 : (b.family > a.family ? -1 : 0));});
    switch (req.params.format) {
      // When json, generate suitable data
      case 'json':
        res.send(people);
	break;
      default:
        res.render('people/index.ejs', { locals: { people: people}});
    }
  });
  
});

app.get('/orgs.:format?', function (req, res){
  var orgs = Organization.find({}, function (err, orgs) {
    orgs.sort(function (a,b) { return (a.name > b.name ? 1 : (b.name > a.name ? -1 : 0));});
    switch (req.params.format) {
      // When json, generate suitable data
      case 'json':
        res.send(org);
	break;
      default:
        res.render('orgs/index.ejs', { locals: { orgs: orgs}});
    }
  });  
});

app.get('/orgs/:id.:format?', function(req, res, next){
    Organization.findOne({w3cId: req.params.id})
        .populate('employees', ['login', 'w3cId', 'given', 'family', 'picture_thumb'])
	.run( function(err, org) {
	    if (org) {
		var employees = org.employees.slice(0); // slice(0) to work around bug in populating arrays
		console.log(JSON.stringify(employees));
		switch (req.params.format) {
		case 'json':
		    res.send(org);
		    break;
		default:
		    res.render('orgs/org.ejs', { locals: { org: org, people:employees}}); 
		}
	    } else {
		next();
	    }
	});  
});



app.get('/taxi/', function (req, res) {
  res.render('taxi/index.ejs');
});

app.get('/taxi/from', function (req, res) {
  TaxiFromAirport.find({}).populate('requester', ['w3cId', 'given', 'family', 'picture_thumb']).run (function (err, taxi) {
     req.flash('error',err);
     res.render('taxi/from.ejs', {locals: {taxi: taxi}});
});
});

app.post('/taxi/from',
  form(
	 validate("airport").required().custom(function(n) { if (!( n in {'San Jose':1, 'San Francisco':1, 'Oakland':1})) throw new Error('%s is not valid airport');}),
	 validate("terminal").required(),
	 validate("arrival").required().regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]*)?)?", "%s must match YYYY-MM-DDTHH:mm(:ss)?")
  ),
  function (req, res) {
  if (! req.loggedIn) {
    req.session.redirectTo = '/taxi/from';
    return res.redirect(everyauth.password.getLoginPath());
  }
  if (!req.form.isValid) {
       TaxiFromAirport.find({}).populate('requester', ['w3cId', 'given', 'family', 'picture_thumb']).run( function (err, taxi) {
	 req.flash('error',err);
 	 res.render('taxi/from.ejs', {locals: {taxi: taxi}});
        });
  } else {
     var taxi = new TaxiFromAirport({flight: {airport: req.form.airport, eta: req.form.arrival, airline: req.form.airline, code: req.form.code, terminal: req.form. terminal}, requester: req.user._id});
     taxi.save(function (err) {
       req.flash('error',err);
       TaxiFromAirport.find({}).populate('requester', ['w3cId', 'given', 'family', 'picture_thumb']).run( function (err, taxi) {
	 req.flash('error',err);
 	 res.render('taxi/from.ejs', {locals: {taxi: taxi}});
        });
      });
  }
});



app.get('/taxi/to', function (req, res) {
  TaxiToAirport.find({}).populate('requester', ['w3cId', 'given', 'family', 'picture_thumb']).run( function (err, taxi) {
     req.flash('error',err);
     res.render('taxi/to.ejs', {locals: {taxi: taxi}});
  });
});

app.post('/taxi/to',
  form(
	 validate("airport").required().custom(function(n) { if (!( n in {'San Jose':1, 'San Francisco':1, 'Oakland':1})) throw new Error('%s is not valid airport');}),
	 validate("departureDate").required().regex("[0-9]{4}-[0-9]{2}-[0-9]{2}", "%s must match YYYY-MM-DD"),
	 validate("minDepartureTime").required().regex("[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]*)?)?", "%s must match HH:mm"),
	 validate("maxDepartureTime").required().regex("[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]*)?)?", "%s must match HH:mm")
  ),
  function (req, res) {
  if (! req.loggedIn) {
    req.session.redirectTo = '/taxi/to';
    return res.redirect(everyauth.password.getLoginPath());
  }
  if (!req.form.isValid) {
       TaxiToAirport.find({}).populate('requester', ['w3cId', 'given', 'family', 'picture_thumb']).run( function (err, taxi) {
	 req.flash('error',err);
 	 res.render('taxi/to.ejs', {locals: {taxi: taxi}});
        });
  } else {
     var taxi = new TaxiToAirport({airport: req.form.airport, minTime: req.form.departureDate + 'T' + req.form.minDepartureTime + 'Z', maxTime: req.form.departureDate + 'T' + req.form.maxDepartureTime + 'Z', requester: req.user._id});
     taxi.save(function (err) {
       req.flash('error',err);
       TaxiToAirport.find({}).populate('requester', ['w3cId', 'given', 'family', 'picture_thumb']).run( function (err, taxi) {
	 req.flash('error',err);
 	 res.render('taxi/to.ejs', {locals: {taxi: taxi}});
        });
      });
  }

});

everyauth.helpExpress(app);
app.dynamicHelpers({ messages: require('express-messages') });
app.listen(  app.set('port'));
console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
