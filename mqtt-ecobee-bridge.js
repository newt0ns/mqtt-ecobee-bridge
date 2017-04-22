// Requirements
const mqtt = require('mqtt')
const logging = require('./homeautomation-js-lib/logging.js')
const mqtt_helpers = require('./homeautomation-js-lib/mqtt_helpers.js')
const repeat = require('repeat')
const request = require('request')
const Configstore = require('configstore')
const pkg = require('./package.json')
const f2c = require('fahrenheit-to-celsius')


// create a Configstore instance with an unique ID e.g.
// Package name and optionally some default values
const conf = new Configstore(pkg.name, { foo: 'bar' })

const ecobeeClientID = 'AX3EpkzokNDHGoozr1uDCRAgNtbdJb22'

// Config
const host = process.env.MQTT_HOST

// Set up modules
logging.set_enabled(true)

// Setup MQTT
var client = mqtt.connect(host)

// MQTT Observation

client.on('connect', () => {
    logging.log('Reconnecting...\n')
    client.subscribe('#')
})

client.on('disconnect', () => {
    logging.log('Reconnecting...\n')
    client.connect(host)
})

client.on('message', (topic, message) => {
    logging.log(' ' + topic + ':' + message)
})

function setRefreshToken(token) {
    conf.set('refresh-token', token)

}

function getRefreshToken() {
    return conf.get('refresh-token')
}

function setAccessToken(accessToken) {
    conf.set('access-token', accessToken)
}

function getAccessToken() {
    return conf.get('access-token')
}

function requestPIN(callback) {
    // GET
    var ecobeeGetPinURL = 'https://api.ecobee.com/authorize?response_type=ecobeePin&client_id=' + ecobeeClientID + '&scope=smartWrite'

    logging.log('queryPinURL: ' + ecobeeGetPinURL)

    request.get({ url: ecobeeGetPinURL, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }

            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        })
}

function queryRefreshToken(callback) {
    // POST
    var ecobeeAccessToken = getAccessToken()
    logging.log('ecobeeAccessToken: ' + ecobeeAccessToken)
    var ecobeeGetRefreshTokenURL = 'https://api.ecobee.com/token?grant_type=ecobeePin&code=' + ecobeeAccessToken + '&client_id=' + ecobeeClientID

    logging.log('queryRefreshToken: ' + ecobeeGetRefreshTokenURL)

    request.post({ url: ecobeeGetRefreshTokenURL, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }

            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        }).auth(null, null, true, ecobeeAccessToken)
}

function queryAccessToken(callback) {
    // POST
    var ecobeeRefreshToken = getRefreshToken()
    var ecobeeGetAccessTokenURL = 'https://api.ecobee.com/token?grant_type=refresh_token&code=' + ecobeeRefreshToken + '&client_id=' + ecobeeClientID

    logging.log('queryAccessToken: ' + ecobeeGetAccessTokenURL)

    request.post({ url: ecobeeGetAccessTokenURL, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }

            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        }).auth(null, null, true, ecobeeRefreshToken)
}

function queryThermostats(callback) {
    // POST
    var ecobeeAccessToken = getAccessToken()
    var ecobeeGetThermostatInfoURL = 'https://api.ecobee.com/1/thermostat?format=json&body=%7B%22selection%22%3A%7B%22includeAlerts%22%3A%22false%22%2C%22selectionType%22%3A%22registered%22%2C%22selectionMatch%22%3A%22%22%2C%22includeEvents%22%3A%22false%22%2C%22includeSettings%22%3A%22false%22%2C%22includeRuntime%22%3A%22true%22%2C%22includeSensors%22%3A%22true%22%2C%22includeExtendedRuntime%22%3A%22true%22%2C%22includeEquipmentStatus%22%3A%22true%22%2C%22includeEvents%22%3A%22true%22%7D%7D'

    logging.log('queryThermostats: ' + ecobeeGetThermostatInfoURL)

    request.get({ url: ecobeeGetThermostatInfoURL, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }

            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        }).auth(null, null, true, ecobeeAccessToken)
}

function querySensors(callback) {
    // POST
    var ecobeeAccessToken = getAccessToken()
    var ecobeeGetSensorInfoURL = 'https://api.ecobee.com/1/thermostatSummary?format=json&body=%7B%22selection%22%3A%7B%22includeAlerts%22%3A%22false%22%2C%22selectionType%22%3A%22registered%22%2C%22selectionMatch%22%3A%22%22%2C%22includeEvents%22%3A%22false%22%2C%22includeSettings%22%3A%22false%22%2C%22includeRuntime%22%3A%22true%22%2C%22includeSensors%22%3A%22true%22%2C%22includeExtendedRuntime%22%3A%22true%22%2C%22includeEquipmentStatus%22%3A%22true%22%2C%22includeEvents%22%3A%22true%22%7D%7D'

    logging.log('querySensors')

    request.get({ url: ecobeeGetSensorInfoURL, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }

            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        }).auth(null, null, true, ecobeeAccessToken)
}

// auto, cool, heat, off
function setHVACMode(mode, callback) {
    // POST
    var ecobeeAccessToken = getAccessToken()
    var ecobeeActionURL = 'https://api.ecobee.com/1/thermostat?format=json'

    logging.log('setHVACMode: ' + mode)

    var postBody = { 'selection': { 'selectionType': 'registered', 'selectionMatch': '' }, 'thermostat': { 'settings': { 'hvacMode': mode } } }

    request.post({ url: ecobeeActionURL, body: postBody, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))

            }
            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        }).auth(null, null, true, ecobeeAccessToken)
}

// sleep, home, away
function setMode(mode, callback) {
    // POST
    var ecobeeAccessToken = getAccessToken()
    var ecobeeActionURL = 'https://api.ecobee.com/1/thermostat?format=json'

    logging.log('setHVACMode: ' + mode)

    var postBody = { 'selection': { 'selectionType': 'registered', 'selectionMatch': '' }, 'functions': [{ 'type': 'setHold', 'params': { 'holdType': 'indefinite', 'holdClimateRef': mode } }] }

    request.post({ url: ecobeeActionURL, body: postBody, json: true },
        function(err, response, body) {
            if (err !== null && err !== undefined) {
                logging.log('error:' + err)
                logging.log('response:' + response)
                logging.log('body:' + JSON.stringify(body))
            }
            if (callback !== null && callback !== undefined) {
                callback(err, body)
            }
        }).auth(null, null, true, ecobeeAccessToken)
}

var hasRequestedPIN = false

function periodicRefresh() {
    const ecobeeRefreshToken = getRefreshToken()

    var hasRefreshToken = ecobeeRefreshToken !== null

    if (hasRefreshToken) {
        logging.log('Refreshing tokens')
        renewTokens()
    }
}

function runLoop() {
    const ecobeeAccessToken = getAccessToken()
    const ecobeeRefreshToken = getRefreshToken()

    var hasAccessToken = ecobeeAccessToken !== null
    var hasRefreshToken = ecobeeRefreshToken !== null

    if (hasAccessToken) {
        logging.log('Has access token')
    }

    if (hasRefreshToken) {
        logging.log('Has refresh token')
    }

    if (hasAccessToken) {
        doPoll()
    } else {
        if (!hasRequestedPIN) {
            hasRequestedPIN = true
            requestPIN(function(err, body) {
                const ecobeePin = body.ecobeePin
                const accessToken = body.code

                logging.log('Ecobee Pin: ' + ecobeePin + '   Access Token: ' + accessToken)

                setAccessToken(accessToken)
            })
        }
    }
}

function renewTokens() {
    logging.log('Renewing tokens')

    queryAccessToken(function(err, body) {
        const refreshToken = body.refresh_token
        const accessToken = body.access_token

        logging.log('Reloaded tokens - refresh Token: ' + refreshToken + '   access Token: ' + accessToken)
        if (refreshToken)
            setRefreshToken(refreshToken)
        if (accessToken)
            setAccessToken(accessToken)
    })

}

function doPoll() {
    queryThermostats(function(err, body) {
        logging.log('Loaded thermostats')
        if (err !== null) {
            logging.log('error:' + err)
            logging.log('body:' + JSON.stringify(body))
        }

        if (err !== null) {
            logging.log('Thermostat query failed, loading tokens')
            renewTokens()
        } else {
            logging.log('Loading done:')
            const thermostatList = body.thermostatList
            const thermostat = thermostatList[0]
            const thermostatName = thermostat.name
            const events = thermostat.events[0]
            const mode = events.holdClimateRef
            const fan = events.fan
            const remoteSensors = thermostat.remoteSensors

            logging.log('thermostatName:' + thermostatName)
            logging.log('mode:' + mode)
            logging.log('fan:' + fan)
            logging.log('remoteSensors:' + remoteSensors)


            remoteSensors.forEach(function(sensor) {
                // logging.log('sensor:' + JSON.stringify(sensor))
                const sensorName = sensor.name
                const capabilities = sensor.capability
                capabilities.forEach(function(capability) {
                    const type = capability.type
                    var value = capability.value
                    if (type === 'temperature') {
                        value = (Number(value) / 10)
                        value = f2c(value).toFixed(1)
                    }
                    logging.log('   name:' + sensorName + ' type: ' + type + '    value: ' + value)
                }, this)
            }, this)

        }
    })
}
// setMode('home', function(err, body) {
//     logging.log('Loaded thermostats')
//     logging.log('error:' + err)
//     logging.log('body:' + JSON.stringify(body))
// })

// setHVACMode('auto', function(err, body) {
//     logging.log('Loaded thermostats')
//     logging.log('error:' + err)
//     logging.log('body:' + JSON.stringify(body))
// })



repeat(runLoop).every(30, 's').start.in(1, 'sec')
repeat(periodicRefresh).every(8, 'm').start.in(10, 'sec')