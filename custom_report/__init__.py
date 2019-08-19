# -*- coding: utf-8 -*-
from __future__ import unicode_literals
import frappe
__version__ = '0.0.1'


@frappe.whitelist()
def get_agGrid_licenseKey():
    return frappe.get_conf().agGrid_licenseKey or ""
