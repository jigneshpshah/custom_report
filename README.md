## Custom Report

Alternative for query report to use ag-grid

- install custom_report app
```
bench --site mysite install-app custom_report
```

- copy desired version of [ag-grid](https://github.com/ag-grid/ag-grid/blob/master/packages/ag-grid-community/dist/ag-grid-community.min.js)  to custom_report/public/js/lib/

- check the path to ag-grid file in custom_report/hooks.py under app_include_js 

- if you choose the Enterprise version , add your license key in site_config.json
```
"agGrid_licenseKey": "*************",
```
- for any query report replace query-report with ag-report in url

- advanced features of ag-grid can be used with custom js in the .js file of any standard query report. 

#### License

MIT