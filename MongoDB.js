'use strict';
var mongoose = require('mongoose');
var projector = require("nodetiles-core").projector;
var __ = require("lodash");


/**
 * Turn stored a stored parcel result into geoJSON
 * TODO: Can save time and memory by not creating a new object here.
 * @param  {Object} item  A single response
 * @return {Object}       A single response structured as geoJSON
 */
function resultToGeoJSON(item) {
  item.type = 'Feature';

  // Get the geo info
  if (item.geo_info.geometry !== undefined) {
    item.id = item.object_id;
    item.geometry = item.geo_info.geometry;
  }else {
    // Or if there isn't one, use the centroid.
    item.id = item._id;
    item.geometry = {};
    item.geometry.type = 'Point';
    item.geometry.coordinates = item.geo_info.centroid;
  }

  // Fill out the properties.
  // These are used for UTF grids
  item.properties = {};

  // Copy all the responses
  __.extend(item.properties, item.responses);

  // Add the geometries to the properties for use in the UTF grids
  // We need to do a deep copy here, otherwise we'll get the reprojected
  // geometries later.
  // TODO: if we're  generating PNGs, we don't need to copy geometries.
  item.properties.geometry = __.cloneDeep(item.geo_info.geometry);
  item.properties.name = item.geo_info.humanReadableName;
  item.properties.object_id = item.object_id;

  // Clean up a bit
  delete item.geo_info.centroid;
  delete item.geo_info.geometry;
  delete item.responses;

  return item;
}

var MongoSource = function(options) {
  this._projection = projector.util.cleanProjString(options.projection || 'EPSG:4326');
  // Either options.db or options.connectionString is required.
  if (options.db) {
    this._db = options.db;
  } else {
    this._connectionString = options.connectionString;
    mongoose.connect(this._connectionString);
    this._db = mongoose.connection;
  }
  this._collectionName = options.collectionName;     // required
  this._geoKey = options.key;                        // required - name of the geodata field
  this._query =   options.query;                     // required - a query to get started with
  this._select = options.select;                     // required - fields to select
  this._filter = options.filter;                     // optional - key to filter data
  this.sourceName = options.name || 'localdata';
  return this;
};

MongoSource.prototype = {
  constructor: MongoSource,

  getMostRecent: function(minX, minY, maxX, maxY, mapProjection, callback) {
    // First, we need to turn the coordinates into a bounds query for Mongo
    var min = [minX, minY];
    var max = [maxX, maxY];

    // project request coordinates into data coordinates
    if (mapProjection !== this._projection) {
      min = projector.project.Point(mapProjection, this._projection, min);
      max = projector.project.Point(mapProjection, this._projection, max);
    }

    var query = this._query || {};
    var parsedBbox = [[min[0], min[1]], [max[0],  max[1]]];
    query[this._geoKey] = { '$within': { '$box': parsedBbox } };

    var options = { sort: { 'created' : -1 } };

    this._db.collection(this._collectionName)
    .findOne(this._query, this._select, options, function (error, result) {
      if (error) {
        console.log(error);
        callback(error);
      }
      callback(null, result);
    });

  },

  getShapes: function(minX, minY, maxX, maxY, mapProjection, callback) {

    // First, we need to turn the coordinates into a bounds query for Mongo
    var min = [minX, minY];
    var max = [maxX, maxY];

    // project request coordinates into data coordinates
    if (mapProjection !== this._projection) {
      min = projector.project.Point(mapProjection, this._projection, min);
      max = projector.project.Point(mapProjection, this._projection, max);
    }

    var query = this._query || {};
    var parsedBbox = [[min[0], min[1]], [max[0],  max[1]]];
    query[this._geoKey] = { '$within': { '$box': parsedBbox } };

    var start;

    function handleStream(stream) {
      var features = [];

      function addFeature(doc) {
        features.push(resultToGeoJSON(doc));
      }

      stream.on('data', addFeature);

      stream.on('close', function() {
        console.log("Fetched and processed " + features.length + " responses in " + (Date.now() - start) + "ms");

        callback(null, {
          type: 'FeatureCollection',
          features: features
        });
      });
    }


    var self = this;
    function handleCursor(cursor) {
      // The same thing as above, except using toArray
      // NB -- conversion to a format that the renderer wants is broken
      cursor.toArray(function(error, results) {
        if(error) {
          console.log("Error fetching results: ", error);
        }

        if(results) {
          console.log("Fetched " + results.length + " responses in " + (Date.now() - start) + "ms");
        }

        start = Date.now();
        var len = results.length;

        // Convert the results to geojson
        for (var i = 0; i < len; i++) {
          results[i] = resultToGeoJSON(results[i]);
        }

        var fc = {
          type: 'FeatureCollection',
          features: results
        };

        if (self._projection !== mapProjection) {
          fc = projector.project.FeatureCollection(self._projection, mapProjection, fc);
        }

        console.log("Processed " + results.length + " responses in " + (Date.now() - start) + "ms");

        callback(null, fc);

      }.bind(this));
    }


      start = Date.now();

      // console.log("Query %j %j", this._query, this._select);

      // ----------------------------------------------------------
      // Get the data
      // Set to true to try streaming
      // Streaming is both broken and not optimized
      if(false) {
        var stream = this._db.collection(this._collectionName)
          .find(this._query, this._select)
          .stream();
        handleStream(stream);
      } else {

        console.log("SELECTING", this._select);
        this._db.collection(this._collectionName)
        .find(this._query, this._select, function (error, cursor) {
          if (error) {
            console.log(error);
            callback(error);
          }
          handleCursor(cursor);
        });
      }

      // Going to skip reprojecting
      // features.push(projectFeature(mapProjection, geoJSONDoc));
    //}.bind(this));
  }
};

module.exports = MongoSource;
