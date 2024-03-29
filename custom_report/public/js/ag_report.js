frappe.provide('frappe.views');
frappe.provide('frappe.ag_reports');

frappe.standard_pages['ag-report'] = function () {

    var wrapper = frappe.container.add_page('ag-report');

    frappe.ui.make_app_page({
        parent: wrapper,
        title: __('ag Report'),
        single_column: true,
    });

    frappe.ag_report = new frappe.views.AgReport({
        parent: wrapper,
    });

    $(wrapper).bind('show', function () {
        $(wrapper).find('.container.page-body').addClass('col-md-12');
        frappe.ag_report.show();
    });

};


frappe.views.AgReport = class AgReport extends frappe.views.BaseList {

    show() {
        this.init().then(() => this.load());
    }

    init() {
        if (this.init_promise) {
            return this.init_promise;
        }

        let tasks = [
            frappe.set_ag_license,
            this.setup_defaults,
            this.setup_page,
            this.setup_report_wrapper,
        ].map(fn => fn.bind(this));
        this.init_promise = frappe.run_serially(tasks);
        return this.init_promise;
    }

    setup_defaults() {
        this.route = frappe.get_route();
        this.page_name = frappe.get_route_str();

        // Setup buttons
        this.primary_action = null;
        this.secondary_action = {
            label: __('Refresh'),
            action: () => {
                this.refresh();
            }
        };

        // throttle refresh for 300ms
        this.refresh = frappe.utils.throttle(this.refresh, 300);

        this.menu_items = [];
    }

    load() {
        if (frappe.get_route().length < 2) {
            this.toggle_nothing_to_show(true);
            return;
        }
        if (this.report_name !== frappe.get_route()[1]) {
            // this.toggle_loading(true);
            // different report
            this.load_report();
        } else {
            // same report
            this.refresh_report();
        }
    }

    load_report() {

        this.page.clear_inner_toolbar();
        this.route = frappe.get_route();
        this.page_name = frappe.get_route_str();
        this.report_name = this.route[1];
        this.page_title = __(this.report_name);
        this.menu_items = this.get_menu_items();
        this.datatable = null;
        this.$report.empty();

        frappe.run_serially([
            () => this.get_report_doc(),
            () => this.get_report_settings(),
            () => this.setup_page_head(),
            () => this.refresh_report(),
        ]);
    }

    refresh_report() {
        this.toggle_message(true);

        return frappe.run_serially([
            () => this.setup_filters(),
            () => this.set_route_filters(),
            () => this.report_settings.onload && this.report_settings.onload(this),
            () => this.get_user_settings(),
            () => this.refresh()
        ]);
    }

    get_report_doc() {
        return frappe.model.with_doc('Report', this.report_name)
            .then(doc => {
                this.report_doc = doc;
            })
            .then(() => frappe.model.with_doctype(this.report_doc.ref_doctype));
    }

    get_report_settings() {
        if (frappe.query_reports[this.report_name]) {
            this.report_settings = frappe.query_reports[this.report_name];
            return this._load_script;
        }

        this._load_script = (new Promise(resolve => frappe.call({
            method: 'frappe.desk.query_report.get_script',
            args: { report_name: this.report_name },
            callback: resolve
        }))).then(r => {
            frappe.dom.eval(r.message.script || '');
            return r;
        }).then(r => {
            return frappe.after_ajax(() => {
                this.report_settings = frappe.query_reports[this.report_name];
                this.report_settings.html_format = r.message.html_format;
                this.report_settings.execution_time = r.message.execution_time || 0;
            });
        });

        return this._load_script;
    }

    setup_filters() {
        this.clear_filters();
        const { filters = [] } = this.report_settings;

        this.filters = filters.map(df => {
            if (df.fieldtype === 'Break') return;

            let f = this.page.add_field(df);

            if (df.default) {
                f.set_input(df.default);
            }

            if (df.get_query) f.get_query = df.get_query;
            if (df.on_change) f.on_change = df.on_change;

            df.onchange = () => {
                if (this.previous_filters
                    && (JSON.stringify(this.previous_filters) == JSON.stringify(this.get_filter_values()))) {
                    // filter values have not changed
                    return;
                }
                this.previous_filters = this.get_filter_values();

                // clear previous_filters after 3 seconds, to allow refresh for new data
                setTimeout(() => this.previous_filters = null, 10000);

                if (f.on_change) {
                    f.on_change(this);
                } else {
                    if (this.prepared_report) {
                        this.reset_report_view();
                    }
                    else if (!this._no_refresh) {
                        this.refresh();
                    }
                }
            };

            f = Object.assign(f, df);

            return f;

        }).filter(Boolean);

        if (this.filters.length === 0) {
            // hide page form if no filters
            this.page.hide_form();
        } else {
            this.page.show_form();
        }
    }

    set_filters(filters) {
        this.filters.map(f => {
            f.set_input(filters[f.fieldname]);
        });
    }

    set_route_filters() {
        if (frappe.route_options) {
            const fields = Object.keys(frappe.route_options);

            const filters_to_set = this.filters.filter(f => fields.includes(f.df.fieldname));

            const promises = filters_to_set.map(f => {
                return () => {
                    const value = frappe.route_options[f.df.fieldname];
                    return f.set_value(value);
                };
            });
            promises.push(() => {
                frappe.route_options = null;
            });

            return frappe.run_serially(promises);
        }
    }

    clear_filters() {
        this.page.clear_fields();
    }

    refresh() {
        this.toggle_message(true);
        let filters = this.get_filter_values(true);

        let query = frappe.utils.get_query_string(frappe.get_route_str());

        if (query) {
            let obj = frappe.utils.get_query_params(query);
            filters = Object.assign(filters || {}, obj);
        }

        frappe.query_reports[this.report_name].cached_filters = filters || {};

        // only one refresh at a time
        if (this.last_ajax) {
            this.last_ajax.abort();
        }

        return new Promise(resolve => {
            this.last_ajax = frappe.call({
                method: 'frappe.desk.query_report.run',
                type: 'GET',
                args: {
                    report_name: this.report_name,
                    filters: filters,
                },
                callback: resolve,
                always: () => this.page.btn_secondary.prop('disabled', false)
            })
        }).then(r => {
            let data = r.message;
            this.hide_status();
            clearInterval(this.interval);

            this.execution_time = data.execution_time || 0.1;

            this.toggle_message(false);

            if (data.result && data.result.length) {
                this.prepare_report_data(data);
                this.render_datatable();
            } else {
                this.toggle_nothing_to_show(true);
            }

            this.show_footer_message();
            this.report_settings.update_footer && this.report_settings.update_footer();

            frappe.hide_progress();
        });
    }

    prepare_report_data(data) {
        this.raw_data = data;
        this.columns = this.prepare_columns(data.columns);
        this.data = this.prepare_data(data.result);

        this.tree_report = this.data.some(d => 'indent' in d);
    }

    render_datatable() {
        let data = this.data;
        if (this.raw_data.add_total_row) {
            data = data.slice();
            data.splice(-1, 1);
        }

        let always_recreate = (this.datatable && this.gridOptions.context && this.gridOptions.context.always_recreate) || false;

        if (this.datatable && !always_recreate) {
            this.gridOptions.api.setRowData(data);
        } else {
            if (this.datatable) {
                this.datatable.destroy();
            }
            let datatable_options = {
                columns: this.columns,
                data: data,
                inlineFilters: true,
                treeView: this.tree_report,
                layout: 'fixed',
                cellHeight: 33,
                showTotalRow: this.raw_data.add_total_row,
                hooks: {
                    columnTotal: frappe.utils.report_column_total
                },
            };

            this.gridOptions = {
                columnDefs: datatable_options.columns,
                onGridReady: function (event) {
                    frappe.ag_report.gridOptions.api.setRowData(frappe.ag_report.data)
                },
                floatingFilter: true,
                defaultColDef: { filter: 'agTextColumnFilter' }
            };

            if (this.report_settings.set_gridOptions) {
                this.report_settings.set_gridOptions(this.gridOptions);
            }

            this.datatable = new agGrid.Grid(this.$report[0], this.gridOptions);
        }
        // if (!this.datatable) {
        // } else {
        //     // this.gridOptions.api.setRowData(data);
        // }
        if (this.report_settings.after_datatable_render) {
            this.report_settings.after_datatable_render(this.datatable);
        }

    }

    get_user_settings() {
        return frappe.model.user_settings.get(this.report_name)
            .then(user_settings => {
                this.user_settings = user_settings;
            });
    }

    prepare_columns(columns) {
        return columns.map(column => {
            if (typeof column === 'string') {
                if (column.includes(':')) {
                    let [label, fieldtype, width] = column.split(':');
                    let options;

                    if (fieldtype.includes('/')) {
                        [fieldtype, options] = fieldtype.split('/');
                    }

                    column = {
                        label,
                        fieldname: label,
                        fieldtype,
                        width,
                        options
                    };
                } else {
                    column = {
                        label: column,
                        fieldname: column,
                        fieldtype: 'Data'
                    };
                }
            }

            const format_cell = (value, row, column, data) => {
                return frappe.format(value, column,
                    { for_print: false, always_show_decimals: true }, data);
            };

            let compareFn = null;
            if (column.fieldtype === 'Date') {
                compareFn = (cell, keyword) => {
                    if (!cell.content) return null;
                    if (keyword.length !== 'YYYY-MM-DD'.length) return null;

                    const keywordValue = frappe.datetime.user_to_obj(keyword);
                    const cellValue = frappe.datetime.str_to_obj(cell.content);
                    return [+cellValue, +keywordValue];
                };
            }

            if (column.fieldtype && column.fieldtype.startsWith('Link/')) {
                let option = column.fieldtype.replace('Link/', '');
                column.fieldtype = 'Varchar';
                column.cellRenderer = function (params) {
                    return `<a href='#Form/${option}/${params.value}' target="_blank">${params.value}</a>`;
                }
            }

            let agfilter_for_fieldtype = {
                "Int": "agNumberColumnFilter",
                "Float": "agNumberColumnFilter",
                "Varchar": "agTextColumnFilter",
                "Date": "agDateColumnFilter"
            };

            let agfieldtype_for_fieldtype = {
                "Int": "numericColumn",
                "Float": "numericColumn",
                "Currency": "numericColumn",
                "Date": "dateColumn"
            };

            // fix column types
            if (!column.type && agfieldtype_for_fieldtype[column.fieldtype]) {
                column.type = agfieldtype_for_fieldtype[column.fieldtype];
            }
            else if (column.type && ["Currency", "Float"].includes(column.type)) {
                column.type = 'numericColumn';
            }
            else if (column.type && column.type.startsWith("Link")) {
                delete column.type;
            }

            // fix column filters
            column.filter = agfilter_for_fieldtype[column.fieldtype] || 'agTextColumnFilter';

            if (column.valueGetter) {
                column.valueGetter = eval(column.valueGetter)
            }

            let colDef = Object.assign(column, {
                colId: column.fieldname,
                field: column.fieldname, // for ag-grid
                name: column.label,
                headerName: column.label,
                width: parseInt(column.width) || null
            });

            // fix coldef properties not recognized by ag-grid, which log warnings in console 
            ['label', 'name', 'fieldname', 'fieldtype'].forEach(e => delete colDef[e]);

            return colDef;

        });
    }

    prepare_data(data) {
        return data.map(row => {
            let row_obj = {};
            if (Array.isArray(row)) {
                this.columns.forEach((column, i) => {
                    row_obj[column.colId] = row[i];
                });

                return row_obj;
            }
            return row;
        });
    }

    get_visible_columns() {
        const visible_column_ids = this.datatable.datamanager.getColumns(true).map(col => col.colId);

        return visible_column_ids
            .map(id => this.columns.find(col => col.colId === id))
            .filter(Boolean);
    }

    get_filter_values(raise) {
        const mandatory = this.filters.filter(f => f.df.reqd);
        const missing_mandatory = mandatory.filter(f => !f.get_value());
        if (raise && missing_mandatory.length > 0) {
            let message = __('Please set filters');
            this.toggle_message(raise, message);
            throw "Filter missing";
        }

        const filters = this.filters
            .filter(f => f.get_value())
            .map(f => {
                var v = f.get_value();
                // hidden fields dont have $input
                if (f.df.hidden) v = f.value;
                if (v === '%') v = null;
                return {
                    [f.df.fieldname]: v
                };
            })
            .reduce((acc, f) => {
                Object.assign(acc, f);
                return acc;
            }, {});
        return filters;
    }

    get_filter(fieldname) {
        const field = (this.filters || []).find(f => f.df.fieldname === fieldname);
        if (!field) {
            console.warn(`[Query Report] Invalid filter: ${fieldname}`);
        }
        return field;
    }

    get_filter_value(fieldname) {
        const field = this.get_filter(fieldname);
        return field ? field.get_value() : null;
    }

    set_filter_value(fieldname, value) {
        let field_value_map = {};
        if (typeof fieldname === 'string') {
            field_value_map[fieldname] = value;
        } else {
            field_value_map = fieldname;
        }

        this._no_refresh = true;
        Object.keys(field_value_map)
            .forEach((fieldname, i, arr) => {
                const value = field_value_map[fieldname];

                if (i === arr.length - 1) {
                    this._no_refresh = false;
                }

                this.get_filter(fieldname).set_value(value);
            });
    }

    set_breadcrumbs() {
        if (!this.report_doc || !this.report_doc.ref_doctype) return;
        const ref_doctype = frappe.get_meta(this.report_doc.ref_doctype);
        frappe.breadcrumbs.add(ref_doctype.module);
    }

    print_report(print_settings) {
        const custom_format = this.report_settings.html_format || null;
        const filters_html = this.get_filters_html_for_print();
        const landscape = print_settings.orientation == 'Landscape';

        frappe.render_grid({
            template: custom_format,
            title: __(this.report_name),
            subtitle: filters_html,
            print_settings: print_settings,
            landscape: landscape,
            filters: this.get_filter_values(),
            data: custom_format ? this.data : this.get_data_for_print(),
            columns: custom_format ? this.columns : this.get_columns_for_print(),
            report: this
        });
    }

    pdf_report(print_settings) {
        const base_url = frappe.urllib.get_base_url();
        const print_css = frappe.boot.print_css;
        const landscape = print_settings.orientation == 'Landscape';

        const custom_format = this.report_settings.html_format || null;
        const columns = custom_format ? this.columns : this.get_columns_for_print();
        const data = custom_format ? this.data : this.get_data_for_print();
        const applied_filters = this.get_filter_values();

        const filters_html = this.get_filters_html_for_print();
        const content = frappe.render_template(custom_format || 'print_grid', {
            title: __(this.report_name),
            subtitle: filters_html,
            filters: applied_filters,
            data: data,
            columns: columns,
            report: this
        });

        // Render Report in HTML
        const html = frappe.render_template('print_template', {
            title: __(this.report_name),
            content: content,
            base_url: base_url,
            print_css: print_css,
            print_settings: print_settings,
            landscape: landscape,
            columns: columns
        });

        frappe.render_pdf(html, print_settings);
    }

    get_filters_html_for_print() {
        const applied_filters = this.get_filter_values();
        return Object.keys(applied_filters)
            .map(fieldname => {
                const label = frappe.query_report.get_filter(fieldname).df.label;
                const value = applied_filters[fieldname];
                return `<h6>${__(label)}: ${value}</h6>`;
            })
            .join('');
    }

    export_report() {
        if (this.export_dialog) {
            this.export_dialog.clear();
            this.export_dialog.show();
            return;
        }

        this.export_dialog = frappe.prompt([
            {
                label: __('Select File Format'),
                fieldname: 'file_format',
                fieldtype: 'Select',
                options: ['Excel', 'CSV'],
                default: 'Excel',
                reqd: 1,
                onchange: () => {
                    this.export_dialog.set_df_property('with_indentation',
                        'hidden', this.export_dialog.get_value('file_format') !== 'CSV');
                }
            },
            {
                label: __('With Group Indentation'),
                fieldname: 'with_indentation',
                fieldtype: 'Check',
                hidden: 1
            }
        ], ({ file_format, with_indentation }) => {
            if (file_format === 'CSV') {
                const column_row = this.columns.map(col => col.label);
                const data = this.get_data_for_csv(with_indentation);
                const out = [column_row].concat(data);

                frappe.tools.downloadify(out, null, this.report_name);
            } else {
                let filters = this.get_filter_values(true);
                if (frappe.urllib.get_dict("prepared_report_name")) {
                    filters = Object.assign(frappe.urllib.get_dict("prepared_report_name"), filters);
                }

                const visible_idx = this.datatable.datamanager.getFilteredRowIndices();
                if (visible_idx.length + 1 === this.data.length) {
                    visible_idx.push(visible_idx.length);
                }

                const args = {
                    cmd: 'frappe.desk.query_report.export_query',
                    report_name: this.report_name,
                    file_format_type: file_format,
                    filters: filters,
                    visible_idx: visible_idx,
                };

                open_url_post(frappe.request.url, args);
            }
        }, __('Export Report: ' + this.report_name), __('Download'));
    }

    get_data_for_csv(with_indentation = false) {

        const indices = this.datatable.datamanager.getFilteredRowIndices();
        const rows = indices.map(i => this.datatable.datamanager.getRow(i));
        return rows.map(row => {
            const standard_column_count = this.datatable.datamanager.getStandardColumnCount();
            return row
                .slice(standard_column_count)
                .map((cell, i) => {
                    if (with_indentation && i === 0) {
                        return '   '.repeat(row.meta.indent) + cell.content;
                    }
                    return cell.content;
                });
        });
    }

    get_data_for_print() {
        const indices = this.datatable.datamanager.getFilteredRowIndices();
        return indices.map(i => this.data[i]);
    }

    get_columns_for_print() {
        return this.get_visible_columns();
    }

    get_menu_items() {
        return [
            {
                label: __('Refresh'),
                action: () => this.refresh(),
                class: 'visible-xs'
            },
            {
                label: __('Edit'),
                action: () => frappe.set_route('Form', 'Report', this.report_name),
                condition: () => frappe.user.is_report_manager(),
                standard: true
            },
            {
                label: __('Print'),
                action: () => {
                    frappe.ui.get_print_settings(
                        false,
                        print_settings => this.print_report(print_settings),
                        this.report_doc.letter_head
                    );
                },
                condition: () => frappe.model.can_print(this.report_doc.ref_doctype),
                standard: true
            },
            {
                label: __('PDF'),
                action: () => {
                    frappe.ui.get_print_settings(
                        false,
                        print_settings => this.pdf_report(print_settings),
                        this.report_doc.letter_head
                    );
                },
                condition: () => frappe.model.can_print(this.report_doc.ref_doctype),
                standard: true
            },
            {
                label: __('Export'),
                action: () => this.export_report(),
                standard: true
            },
            {
                label: __('Setup Auto Email'),
                action: () => frappe.set_route('List', 'Auto Email Report', { 'report': this.report_name }),
                standard: true
            },
            {
                label: __('User Permissions'),
                action: () => frappe.set_route('List', 'User Permission', {
                    doctype: 'Report',
                    name: this.report_name
                }),
                condition: () => frappe.model.can_set_user_permissions('Report'),
                standard: true
            },
            {
                label: __('Add to Desktop'),
                action: () => frappe.add_to_desktop(this.report_name, null, this.report_name),
                standard: true
            },
        ];
    }

    setup_report_wrapper() {
        if (this.$report) return;

        let page_form = this.page.main.find('.page-form');
        this.$status = $(`<div class="form-message text-muted small"></div>`)
            .hide().insertAfter(page_form);
        this.$report = $('<div id="ag-report-grid" class="ag-theme-balham" style="height:550px;"></div>')
            .appendTo(this.page.main);
        // this.$report = $('<div class="report-wrapper">').appendTo(this.page.main);
        this.$message = $(this.message_div('')).hide().appendTo(this.page.main);
    }

    show_status(status_message) {
        this.$status.html(status_message).show();
    }

    hide_status() {
        this.$status.hide();
    }

    show_footer_message() {
        const message = "";
        const execution_time_msg = __('{0} records in {1} sec', [(this.data || []).length, this.execution_time || 0.1]);

        this.page.footer.removeClass('hide').addClass('text-muted col-md-12')
            .html(`<span class="text-left col-md-6">${message}</span><span class="text-right col-md-6">${execution_time_msg}</span>`);
    }

    message_div(message) {
        return `<div class='flex justify-center align-center text-muted' style='height: 50vh;'>
			<div>${message}</div>
		</div>`;
    }

    reset_report_view() {
        this.hide_status();
        this.toggle_nothing_to_show(true);
        this.refresh();
    }

    toggle_loading(flag) {
        this.toggle_message(flag, __('Loading') + '...');
    }


    toggle_nothing_to_show(flag) {
        let message = this.prepared_report
            ? __('This is a background report. Please set the appropriate filters and then generate a new one.')
            : __('Nothing to show')

        this.toggle_message(flag, message);
    }

    toggle_message(flag, message) {
        if (flag) {
            this.$message.find('div').html(message);
            this.$message.show();
        } else {
            this.$message.hide();
        }
        this.$report.toggle(!flag);
    }
    // backward compatibility
    get get_values() {
        return this.get_filter_values;
    }

}

frappe.set_ag_license = function () {
    if (agGrid.LicenseManager.licenseKey)
        return Promise.resolve();
    return frappe.call({
        method: "custom_report.get_agGrid_licenseKey",
        callback: function (r) {
            if (r.message)
                agGrid.LicenseManager.setLicenseKey(r.message);
        }
    });
}

frappe.set_redirect_to_ag_report = function () {
    const href = window.location.href;
    const regex = /query-report/g
    if (href.match(regex))
        window.location.href = href.replace(regex, 'ag-report');
    // document.getElementById("ag-report-grid").style.height = "550px";
}
