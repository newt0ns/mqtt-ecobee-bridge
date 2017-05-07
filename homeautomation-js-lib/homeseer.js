const logging = require('./logging.js')
const request = require('request')
var homeseer_json_api_path = null

exports.set_path = function(new_path) {
    homeseer_json_api_path = new_path
}

exports.publish = function(deviceRefID, targetValue) {
    if (homeseer_json_api_path === null || homeseer_json_api_path === undefined) {
        logging.error('homeseer_json_api_path not defined')
        return
    }

    const JSON_Path = '/JSON?request=controldevicebyvalue&ref='
    var homeseer_url = homeseer_json_api_path + JSON_Path + deviceRefID + '&value=' + targetValue

    logging.info('sending homeseer action: ' + homeseer_url, {
        action: 'send-homeseer-action',
        url: homeseer_url
    })
    request(homeseer_url, function(error, response, body) {
        if ((response !== null) || (error !== null && error !== undefined)) {
            logging.error('homeseer action failed: ' + homeseer_url, {
                event: 'homeseer-action-failed',
                error: error,
                code: (response && response.statusCode ? response.statusCode : 'none'),
                body: body,
                url: homeseer_url
            })
        }
    })
}