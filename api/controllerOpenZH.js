'use strict';

const csv = require('csvtojson');
const {Parser} = require('json2csv');
const request = require('request');
const cron = require('node-cron');

var allDataCH;
var allDataFL;

// initial load
loadData();

// reaload each minute
cron.schedule('* * * * *', function () {
    loadData();
});

exports.doc = function (req, res) {
    res.redirect('https://github.com/apfeuti/covid19-rest');
};

exports.allData = function (req, res) {
    var data = applyFilters(allDataCH.concat(allDataFL), req.query);
    var outputData = {};
    outputData['totals'] = calculateTotalsIfJson(data, req);

    if (!req.query.skipRecords || req.query.skipRecords.toLowerCase() !== 'true') {
        outputData['records'] = data;
    }

    makeOutput(outputData, req.query, res);

};

exports.findByCountry = function (req, res) {
    var data = [];

    if (req.params.country.toUpperCase() === 'CH') {
        data = allDataCH;
    } else if (req.params.country.toUpperCase() === 'FL') {
        data = allDataFL;
    }

    var filteredData = applyFilters(data, req.query);
    var outputData = {};
    outputData['totals'] = calculateTotalsIfJson(filteredData, req);

    if (!req.query.skipRecords || req.query.skipRecords.toLowerCase() !== 'true') {
        outputData['records'] = filteredData;
    }

    makeOutput(outputData, req.query, res);

};


exports.findByArea = function (req, res) {
    var data = [];

    // no area support for FL
    if (req.params.country.toUpperCase() === 'CH') {
        data = allDataCH.filter(row => row.abbreviation_canton_and_fl.toUpperCase() === req.params.area.toUpperCase());
    }
    var filteredData = applyFilters(data, req.query);
    var outputData = {};

    if (!req.query.skipRecords || req.query.skipRecords.toLowerCase() !== 'true') {
        outputData['records'] = filteredData;
    }
    makeOutput(outputData, req.query, res);
};

function loadData() {
    allDataCH = [];
    const areas = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SH', 'SZ', 'SO', 'SG', 'TG', 'TI', 'UR', 'VS', 'VD', 'ZG', 'ZH'];
    const promises = [];

    areas.forEach((area, index) => {
        var dataLocation = 'https://raw.githubusercontent.com/openZH/covid_19/master/fallzahlen_kanton_total_csv_v2/COVID19_Fallzahlen_Kanton_' + area + '_total.csv';

        promises.push(
            csv({
                checkType: true
            })
                .fromStream(request.get(dataLocation))
                .then(dataAsJson => {
                    // the merge to 'allData' must be done, when all data from all resources are loaded, otherwise the concat has race-conditions -> use Promise to do async.
                    return new Promise((resolve, reject) => {
                        console.log(new Date().toISOString() + ': data-load from: ' + areas[index] + '. Records: ' + dataAsJson.length);
                        try {
                            resolve(dataAsJson);
                        } catch (e) {
                            console.error(new Date().toISOString() + ': error by data-load from: ' + areas[index] + '. ' + e);
                            reject(e);
                        }
                    });
                })
        );
    });

    csv({
        checkType: true
    })
        .fromStream(request.get('https://raw.githubusercontent.com/openZH/covid_19/master/fallzahlen_kanton_total_csv_v2/COVID19_Fallzahlen_FL_total.csv'))
        .then(dataAsJson => {
            allDataFL = dataAsJson;
            allDataFL = insertMissingDays(allDataFL)
            addForwardedValues(allDataFL);
        });

    Promise.all(promises)
        .then(jsonPerArea => {
            allDataCH = allDataCH.concat(jsonPerArea).flat();
            allDataCH = insertMissingDays(allDataCH)
            addForwardedValues(allDataCH);
        });

}

function insertMissingDays(data) {
    var dataWithoutGaps = []
    var groupedByArea = groupBy(data, 'abbreviation_canton_and_fl');

    Object.entries(groupedByArea).forEach(([key, rowsPerArea]) => {
        // check if we have already an entry for today. If not, add an empty row for today
        if (rowsPerArea[rowsPerArea.length - 1].date !== formatDate_yyyy_mm_dd(new Date())) {
            rowsPerArea.push(getEmptyRow(new Date(), key))
        }

        var initDate = new Date(rowsPerArea[0].date)
        var dayBefore = new Date(initDate.setDate(initDate.getDate() - 1))
        var rowsWithoutGaps = []
        rowsPerArea.forEach(row => {
            var rowDate = new Date(row.date)
            for (var i=1; i < diffDays(rowDate, dayBefore); i++) {
                rowsWithoutGaps.push(getEmptyRow(addDays(dayBefore, i), key))
            }
            rowsWithoutGaps.push(row)
            dayBefore = rowDate
        })
        dataWithoutGaps = dataWithoutGaps.concat(rowsWithoutGaps)
    })
    return dataWithoutGaps

    function getEmptyRow(date, areaKey) {
        return {
            date: formatDate_yyyy_mm_dd(date),
            abbreviation_canton_and_fl: areaKey
        };
    }
}

// If for a particular date a value is not reported by the canton, then openZH reports an empty value (does not forward from previous date).
// This behaviour was discussed on several issues in GitHub and has its reasons. However for many usecases (eg. build aggregated total-values)
// non-empty values are much more practical (instead of empty value, take value from previous-date).
// See https://github.com/openZH/covid_19/issues/459 and referenced issues.
function addForwardedValues(data) {
    var groupedByArea = groupBy(data, 'abbreviation_canton_and_fl');

    Object.entries(groupedByArea).forEach(([key, rowsPerArea]) => {
        var previousRow = null;
        rowsPerArea.forEach(row => {
            if (previousRow === null) {
                {
                    // init previousRow
                    previousRow = {
                        ncumul_tested_fwd: 0,
                        ncumul_conf_fwd: 0,
                        ncumul_hosp_fwd: 0, // deprecated
                        ncumul_ICU_fwd: 0,  // deprecated
                        ncumul_vent_fwd: 0, // deprecated
                        current_hosp_fwd: 0,
                        current_icu_fwd: 0,
                        current_vent_fwd: 0,
                        ncumul_released_fwd: 0,
                        ncumul_deceased_fwd: 0
                    }
                }
            }
            row.ncumul_tested_fwd = row.ncumul_tested;
            if (row.ncumul_tested_fwd === '' || (typeof row.ncumul_tested_fwd === 'undefined')) {
                row.ncumul_tested_fwd = previousRow.ncumul_tested_fwd;
            }

            row.ncumul_conf_fwd = row.ncumul_conf;
            if (row.ncumul_conf_fwd === '' || (typeof row.ncumul_conf_fwd === 'undefined')) {
                row.ncumul_conf_fwd = previousRow.ncumul_conf_fwd;
            }

            // added for backward-compatibility, but is deprecated
            row.ncumul_hosp = row.current_hosp;
            row.ncumul_ICU = row.current_icu;
            row.ncumul_vent = row.current_vent;

            // deprecated
            row.ncumul_hosp_fwd = row.ncumul_hosp;
            if (row.ncumul_hosp_fwd === '' || (typeof row.ncumul_hosp_fwd === 'undefined')) {
                row.ncumul_hosp_fwd = previousRow.ncumul_hosp_fwd;
            }

            // deprecated
            row.ncumul_ICU_fwd = row.ncumul_ICU;
            if (row.ncumul_ICU_fwd === '' || (typeof row.ncumul_ICU_fwd === 'undefined')) {
                row.ncumul_ICU_fwd = previousRow.ncumul_ICU_fwd;
            }

            // deprecated
            row.ncumul_vent_fwd = row.ncumul_vent;
            if (row.ncumul_vent_fwd === '' || (typeof row.ncumul_vent_fwd === 'undefined')) {
                row.ncumul_vent_fwd = previousRow.ncumul_vent_fwd;
            }

            row.current_hosp_fwd = row.current_hosp;
            if (row.current_hosp_fwd === '' || (typeof row.current_hosp_fwd === 'undefined')) {
                row.current_hosp_fwd = previousRow.current_hosp_fwd;
            }

            row.current_icu_fwd = row.current_icu;
            if (row.current_icu_fwd === '' || (typeof row.current_icu_fwd === 'undefined')) {
                row.current_icu_fwd = previousRow.current_icu_fwd;
            }

            row.current_vent_fwd = row.current_vent;
            if (row.current_vent_fwd === '' || (typeof row.current_vent_fwd === 'undefined')) {
                row.current_vent_fwd = previousRow.current_vent_fwd;
            }

            row.ncumul_released_fwd = row.ncumul_released;
            if (row.ncumul_released_fwd === '' || (typeof row.ncumul_released_fwd === 'undefined')) {
                row.ncumul_released_fwd = previousRow.ncumul_released_fwd;
            }

            row.ncumul_deceased_fwd = row.ncumul_deceased;
            if (row.ncumul_deceased_fwd === '' || (typeof row.ncumul_deceased_fwd === 'undefined')) {
                row.ncumul_deceased_fwd = previousRow.ncumul_deceased_fwd;
            }

            previousRow = row;
        });
    });
}

function applyFilters(data, query) {
    return query.date ? data.filter(row => row.date === query.date) : data;

}

function makeOutput(data, query, res) {
    if (query.output && query.output.toLowerCase() === 'csv') {

        res.set('Content-Type', 'text/plain');
        if (data.records && data.records.length > 0) {
            const jsonParser = new Parser();
            res.send(jsonParser.parse(data.records));
        } else {
            res.send('');
        }
    } else {
        res.json(data);
    }
}

function calculateTotalsIfJson(data, req) {
    if ((req.query.output && req.query.output.toLowerCase() === 'csv') || data.length === 0) {
        return null;
    }

    var groupedByArea = groupBy(data, 'abbreviation_canton_and_fl');
    var mostRecentOfEachArea = [];
    Object.entries(groupedByArea).forEach(([key, value]) => {
        // from each area-array, we take only the last-entry (this is the most recent record, since the data are already sorted by date)
        mostRecentOfEachArea.push(value.slice(-1));
    });

    mostRecentOfEachArea = mostRecentOfEachArea.flat();


    return {
        ncumul_tested_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_tested_fwd) || 0).reduce((acc, value) => acc + value),
        ncumul_conf_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_conf_fwd) || 0).reduce((acc, value) => acc + value),

        // deprecated
        ncumul_hosp_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_hosp_fwd) || 0).reduce((acc, value) => acc + value),
        // deprecated
        ncumul_ICU_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_ICU_fwd) || 0).reduce((acc, value) => acc + value),
        // dprecated
        ncumul_vent_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_vent_fwd) || 0).reduce((acc, value) => acc + value),

        current_hosp_fwd: mostRecentOfEachArea.map(row => parseInt(row.current_hosp_fwd) || 0).reduce((acc, value) => acc + value),
        current_icu_fwd: mostRecentOfEachArea.map(row => parseInt(row.current_icu_fwd) || 0).reduce((acc, value) => acc + value),
        current_vent_fwd: mostRecentOfEachArea.map(row => parseInt(row.current_vent_fwd) || 0).reduce((acc, value) => acc + value),

        ncumul_released_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_released_fwd) || 0).reduce((acc, value) => acc + value),
        ncumul_deceased_fwd: mostRecentOfEachArea.map(row => parseInt(row.ncumul_deceased_fwd) || 0).reduce((acc, value) => acc + value)
    };
}

// credits goes to https://stackoverflow.com/questions/14446511/most-efficient-method-to-groupby-on-an-array-of-objects
var groupBy = function (data, key) { // `data` is an array of objects, `key` is the key (or property accessor) to group by
    // reduce runs this anonymous function on each element of `data` (the `item` parameter,
    // returning the `storage` parameter at the end
    return data.reduce(function (storage, item) {
        // get the first instance of the key by which we're grouping
        var group = item[key];

        // set `storage` for this instance of group to the outer scope (if not empty) or initialize it
        storage[group] = storage[group] || [];

        // add this item to its group within `storage`
        storage[group].push(item);

        // return the updated storage to the reduce function, which will then loop through the next
        return storage;
    }, {}); // {} is the initial value of the storage
};

function formatDate_yyyy_mm_dd(date) {
    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0'); //January is 0!
    var yyyy = date.getFullYear();

    return yyyy + '-' + mm + '-' + dd;
}

function diffDays(date1, date2) {
    const diffTime = Math.abs(date1 - date2);
    return  Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function addDays(date, days) {
    var newDate = new Date(date.valueOf());
    newDate.setDate(newDate.getDate() + days);
    return newDate
}