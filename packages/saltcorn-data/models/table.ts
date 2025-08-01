/**
 * Table Database Access Layer
 * @category saltcorn-data
 * @module models/table
 * @subcategory models
 */
import db from "../db";
import {
  sqlsanitize,
  mkWhere,
  mkSelectOptions,
  orderByIsObject,
  orderByIsOperator,
} from "@saltcorn/db-common/internal";
import type {
  Where,
  SelectOptions,
  Row,
  PrimaryKeyValue,
  JoinFields,
  JoinOptions,
  AggregationOptions,
  JoinField,
  Value,
} from "@saltcorn/db-common/internal";

import Field from "./field";
import type {
  AbstractTable,
  TableCfg,
  TablePack,
} from "@saltcorn/types/model-abstracts/abstract_table";
import type { FieldCfg } from "@saltcorn/types/model-abstracts/abstract_field";
import type {
  ForUserRequest,
  AbstractUser,
} from "@saltcorn/types/model-abstracts/abstract_user";

import type { ResultMessage, Type } from "@saltcorn/types/common_types";
import {
  instanceOfErrorMsg,
  instanceOfType,
} from "@saltcorn/types/common_types";

import Trigger from "./trigger";
import expression from "./expression";
const {
  apply_calculated_fields,
  apply_calculated_fields_stored,
  recalculate_for_stored,
  get_expression_function,
  eval_expression,
  freeVariables,
  add_free_variables_to_joinfields,
  removeComments,
  jsexprToWhere,
} = expression;

import type TableConstraint from "./table_constraints";
import type File from "./file";
import { validate as isValidUUID } from "uuid";

import csvtojson from "csvtojson";
import moment from "moment";
import { createReadStream, createWriteStream } from "fs";
import { stat, readFile, writeFile, open } from "fs/promises";
//import { num_between } from "@saltcorn/types/generators";
//import { devNull } from "os";
import utils from "../utils";
const {
  prefixFieldsInWhere,
  InvalidConfiguration,
  InvalidAdminAction,
  satisfies,
  structuredClone,
  getLines,
  mergeIntoWhere,
  stringToJSON,
  isNode,
  apply,
  applyAsync,
  asyncMap,
} = utils;
import tags from "@saltcorn/markup/tags";
const { text } = tags;

import type { AbstractTag } from "@saltcorn/types/model-abstracts/abstract_tag";
import type {
  FieldLike,
  JoinFieldOption,
  RelationOption,
  CalcJoinfield,
  ResultType,
  SlugStepType,
  SubField,
  ErrorObj,
} from "@saltcorn/types/base_types";
import { get_formula_examples } from "./internal/table_helper";
import { getAggAndField, process_aggregations } from "./internal/query";
import async_json_stream from "./internal/async_json_stream";
import { GenObj } from "@saltcorn/db-common/types";

/**
 * Transponce Objects
 * TODO more detailed explanation
 * TODO refactor - move to object util module?
 * @param objs
 * @returns {object}
 */
const transposeObjects = (objs: Row[]): Row => {
  const keys = new Set<string>();
  for (const o of objs) {
    Object.keys(o).forEach((k) => keys.add(k));
  }
  const res: Row = {};
  keys.forEach((k: string) => {
    res[k] = [];
  });
  for (const o of objs) {
    keys.forEach((k: string) => {
      res[k].push(o[k]);
    });
  }
  return res;
};
// todo support also other date formats https://momentjs.com/docs/
const dateFormats = [moment.ISO_8601];
// todo refactor - move to separated data utils module?
/**
 * Is Valid Date of format moment.ISO_8601,
 * example 2010-01-01T05:06:07
 *
 * @param date
 * @returns {boolean}
 */
const isDate = function (date: Date): boolean {
  return moment(date, dateFormats, true).isValid();
};

/**
 * A class representing database tables and their properties.
 *
 * Use this to create or delete tables and their properties, or to query
 * or change table rows.
 *
 * To query, update, insert or delete rows in an existing table, first you
 * should find the table object with {@link Table.findOne}.
 *
 * @example
 * ```
 * Table.findOne({name: "Customers"}) // find the table with name "Customers"
 * Table.findOne("Customers") // find the table with name "Customers" (shortcut)
 * Table.findOne({ id: 5 }) // find the table with id=5
 * Table.findOne(5) // find the table with id=5 (shortcut)
 * ```
 *
 * Table.findOne is synchronous (no need to await), But the functions that
 * query and manipulate (such as {@link Table.insertRow}, {@link Table.getRows},
 * {@link Table.updateRow}, {@link Table.deleteRows}) rows are mostly asyncronous,
 * so you can put the await in front of the
 * whole expression
 *
 * @example
 * To count the number of rows in the customer table
 * ```
 * const nrows = await Table.findOne("Customers").countRows()
 * ```
 *
 * For further examples, see the [Table test suite](https://github.com/saltcorn/saltcorn/blob/master/packages/saltcorn-data/tests/table.test.ts)
 *
 * ## Querying table rows
 *
 * There are several methods you can use to retrieve rows in the database:
 *
 * * {@link Table.countRows} To count the number of rows, optionally matching a criterion
 * * {@link Table.getRows} To retrieve multiple rows matching a criterion
 * * {@link Table.getRow} To retrieve a single row matching a criterion
 * * {@link Table.getJoinedRows} To retrieve rows together with joinfields and aggregations
 *
 * These functions all take `Where` expressions which are JavaScript objects describing
 * the criterion to match to. Some examples:
 *
 * * `{}`: Match all rows
 * * `{ name: "Jim" }`: Match all rows with name="Jim"
 * * `{ name: { ilike: "im"} }`: Match all rows where name contains "im" (case insensitive)
 * * `{ name: /im/ }`: Match all rows with name matching regular expression "im"
 * * `{ age: { lt: 18 } }`: Match all rows with age<18
 * * `{ age: { lt: 18, equal: true } }`: Match all rows with age<=18
 * * `{ age: { gt: 18, lt: 65} }`: Match all rows with 18<age<65
 * * `{ name: { or: ["Harry", "Sally"] } }`: Match all rows with name="Harry" or "Sally"
 * * `{ or: [{ name: "Joe"}, { age: 37 }] }`: Match all rows with name="Joe" or age=37
 * * `{ not: { id: 5 } }`: All rows except id=5
 * * `{ id: { in: [1, 2, 3] } }`: Rows with id 1, 2, or 3
 * * `{ id: { not: { in: [1, 2, 3] } } }`: Rows with id any value except 1, 2, or 3
 *
 * For further examples, see the [mkWhere test suite](https://github.com/saltcorn/saltcorn/blob/master/packages/db-common/internal.test.js)
 *
 * ## Updating a Row
 *
 * There are two nearly identical functions for updating rows depending on how you want
 * failures treated
 *
 * * {@link Table.updateRow} Update a row, throws an exception if update is invalid
 * * {@link Table.tryUpdateRow} Update a row, return an error message if update is invalid
 *
 * ## Inserting a new Row
 *
 * There are two nearly identical functions for inserting a new row depending on how you want
 * failures treated
 *
 * * {@link Table.insertRow} insert a row, throws an exception if it is invalid
 * * {@link Table.tryInsertRow} insert a row, return an error message if it is invalid
 *
 * ## Deleting rows
 *
 * Use {@link Table.deleteRows} to delete any number (zero, one or many) of rows matching a criterion. It uses
 * the same `where` expression as the functions for querying rows
 *
 *
 * @category saltcorn-data
 */
class Table implements AbstractTable {
  /** The table name */
  name: string;

  /** The table ID */
  id?: number;

  /** Minimum role to read */
  min_role_read: number;

  /** Minimum role to write */
  min_role_write: number;

  /** The ID of the ownership field*/
  ownership_field_id?: number | null;

  /** A formula to denote ownership. This is a JavaScript expression which
   * must evaluate to true if the user is the owner*/
  ownership_formula?: string;

  /** Version history enabled for this table */
  versioned: boolean;

  /** Whether sync info for mobile apps is enabled for this table */
  has_sync_info: boolean;

  /** If true this is an external table (not a database table) */
  external: boolean;

  /** A description of the purpose of the table */
  description?: string;

  /** An array of {@link Field}s in this table */
  fields: Field[];

  /** An array of {@link TableConstraint}s for this table */
  constraints: TableConstraint[];

  /** Is this a user group? If yes it will appear as options in the ownership dropdown */
  is_user_group: boolean;

  /** Name of the table provider for this table (not a database table) */
  provider_name?: string;

  /** Configuration for the table provider for this table */
  provider_cfg?: Row;
  /**
   * Table constructor
   * @param {object} o
   */
  constructor(o: TableCfg) {
    this.name = o.name;
    this.id = o.id;
    this.min_role_read = o.min_role_read;
    this.min_role_write = o.min_role_write;
    this.ownership_field_id = o.ownership_field_id;
    this.ownership_formula = o.ownership_formula;
    this.versioned = !!o.versioned;
    this.has_sync_info = !!o.has_sync_info;
    this.is_user_group = !!o.is_user_group;
    this.external = false;
    this.description = o.description;
    this.constraints = o.constraints || [];
    this.provider_cfg = stringToJSON(o.provider_cfg);
    this.provider_name = o.provider_name;

    this.fields = o.fields.map((f) => new Field(f));
  }

  get to_json() {
    return {
      name: this.name,
      id: this.id,
      min_role_read: this.min_role_read,
      min_role_write: this.min_role_write,
      provider_name: this.provider_name,
      ownership_formula: this.ownership_formula,
      ownership_field_id: this.ownership_field_id,
      provider_cfg: this.provider_cfg,
      external: this.external,
      versioned: this.versioned,
      fields: this.fields.map((f) => f.toJson),
    };
  }

  to_provided_table() {
    const tbl = this;
    if (!tbl.provider_name) return this;
    const { getState } = require("../db/state");

    const provider = getState().table_providers[tbl.provider_name];
    if (!provider) return this;
    const { getRows, countRows } = provider.get_table(tbl.provider_cfg, tbl);

    const { json_list_to_external_table } = require("../plugin-helper");
    const t = json_list_to_external_table(getRows, tbl.fields, { countRows });
    delete t.min_role_read; //it is a getter
    Object.assign(t, tbl);
    t.update = async (upd_rec: Row) => {
      const { fields, constraints, ...updDB } = upd_rec;
      await db.update("_sc_tables", updDB, tbl.id);
      //limited refresh if we do not have a client
      if (!db.getRequestContext()?.client)
        await require("../db/state").getState().refresh_tables(true);
    };
    t.delete = async (upd_rec: Row) => {
      const schema = db.getTenantSchemaPrefix();
      await db.deleteWhere("_sc_tag_entries", { table_id: this.id });
      await db.query(`delete FROM ${schema}_sc_tables WHERE id = $1`, [tbl.id]);
      //limited refresh if we do not have a client
      if (!db.getRequestContext()?.client)
        await require("../db/state").getState().refresh_tables(true);
    };
    return t;
  }

  /**
   *
   * Find one Table
   *
   * @param where - where condition
   * @returns {*|Table|null} table or null
   */
  static findOne(where: Where | Table | number | string): Table | null {
    if (
      where &&
      ((where.constructor && where.constructor.name === "Table") ||
        (where as any).getRows)
    )
      return <Table>where;
    // todo add string & number as possible types for where
    if (typeof where === "string") return Table.findOne({ name: where });
    if (typeof where === "number") return Table.findOne({ id: where });
    if (typeof where === "undefined") return null;
    if (where === null) return null;

    const { getState } = require("../db/state");

    // it works because external table hasn't id so can be found only by name
    if (where?.name) {
      const extTable = getState().external_tables[where.name];
      if (extTable) return extTable;
    }

    const tbl = getState().tables.find(
      where?.id
        ? (v: TableCfg) => v.id === +where.id
        : where?.name
          ? (v: TableCfg) => v.name === where.name
          : satisfies(where)
    );
    if (tbl?.provider_name) {
      return new Table(structuredClone(tbl)).to_provided_table();
    } else return tbl ? new Table(structuredClone(tbl)) : null;
  }

  /**
   * Find Tables
   * @param where - where condition
   * @param selectopts - options
   * @returns {Promise<Table[]>} table list
   */
  static async find(
    where?: Where,
    selectopts: SelectOptions = { orderBy: "name", nocase: true }
  ): Promise<Table[]> {
    if (selectopts.cached) {
      const { getState } = require("../db/state");
      return getState()
        .tables.map((t: TableCfg) => new Table(structuredClone(t)))
        .filter(satisfies(where || {}));
    }

    if (where?.name) {
      const { getState } = require("../db/state");
      const extTable = getState().external_tables[where.name];
      if (extTable) return [extTable];
    }

    const tbls = await db.select("_sc_tables", where, selectopts);

    const flds = await db.select(
      "_sc_fields",
      db.isSQLite ? {} : { table_id: { in: tbls.map((t: TableCfg) => t.id) } },
      selectopts
    );
    const _TableConstraint = (await import("./table_constraints")).default;

    const constraints = await _TableConstraint.find(
      db.isSQLite ? {} : { table_id: { in: tbls.map((t: TableCfg) => t.id) } }
    );

    return await asyncMap(tbls, async (t: TableCfg) => {
      if (t.provider_name) {
        const { getState } = require("../db/state");
        const provider = getState().table_providers[t.provider_name];
        if (provider)
          t.fields = await applyAsync(provider.fields, t.provider_cfg);
        else t.fields = [];
      } else
        t.fields = flds
          .filter((f: FieldCfg) => f.table_id === t.id)
          .map((f: FieldCfg) => new Field(f));

      t.constraints = constraints
        .filter((f: any) => f.table_id === t.id)
        .map((f: any) => new _TableConstraint(f));
      const tbl = new Table(t);
      return tbl.to_provided_table();
    });
  }

  /**
   * Find Tables including external tables
   * @param where0
   * @param selectopts
   * @returns {Promise<object[]>}
   */
  static async find_with_external(
    where0: Where = {},
    selectopts: SelectOptions = { orderBy: "name", nocase: true }
  ): Promise<Table[]> {
    const { external, ...where } = where0;
    let externals: Array<Table> = [],
      dbs = [];
    if (external !== false) {
      //do include externals
      const { getState } = require("../db/state");
      externals = Object.values(getState().external_tables);
    }
    if (external !== true) {
      //do include db tables
      const tbls = await db.select("_sc_tables", where, selectopts);
      const flds = await db.select(
        "_sc_fields",
        db.isSQLite
          ? {}
          : { table_id: { in: tbls.map((t: TableCfg) => t.id) } },
        selectopts
      );
      dbs = tbls.map((t: TableCfg) => {
        t.fields = flds
          .filter((f: FieldCfg) => f.table_id === t.id)
          .map((f: FieldCfg) => new Field(f));

        return new Table(t);
      });
    }
    return [...dbs, ...externals];
  }

  /**
   * Get Models
   * tbd why this function in this file - needs to models
   * @param opts
   */
  async get_models(where?: Where | string) {
    const Model = require("./model");
    if (typeof where === "string")
      return await Model.find({ name: where, table_id: this.id });
    else return await Model.find({ ...(where || {}), table_id: this.id });
  }

  /**
   * Get owner column name
   * @param fields - fields list
   * @returns {null|*} null or owner column name
   */
  owner_fieldname_from_fields(fields?: Field[] | null): string | null {
    if (!this.ownership_field_id || !fields) return null;
    const field = fields.find((f: Field) => f.id === this.ownership_field_id);
    return field?.name || null;
  }

  /**
   * Get owner column name
   * @returns {Promise<string|null|*>}
   */
  owner_fieldname(): string | null {
    if (this.name === "users") return "id";
    if (!this.ownership_field_id) return null;
    return this.owner_fieldname_from_fields(this.fields);
  }

  /**
   * Check if user is owner of row
   * @param user - user
   * @param row - table row
   * @returns {boolean}
   */
  is_owner(user: AbstractUser | undefined, row: Row): boolean {
    if (!user) return false;

    if (this.ownership_formula && this.fields) {
      const f = get_expression_function(this.ownership_formula, this.fields);
      return !!f(row, user);
    }
    const field_name = this.owner_fieldname();

    // users are owners of their own row in users table
    if (this.name === "users" && !field_name)
      return !!user.id && `${row?.id}` === `${user.id}`;

    return (
      typeof field_name === "string" &&
      (row[field_name] === user.id || row[field_name]?.id === user.id)
    );
  }

  /**
   * get Ownership options
   * user interface...
   */
  async ownership_options(): Promise<{ label: string; value: string }[]> {
    const fields = this.fields;

    //start with userfields
    const opts: { label: string; value: string }[] = fields
      .filter((f) => f.reftable_name === "users")
      .map((f) => ({ value: `${f.id}`, label: f.name }));

    const users = Table.findOne({ name: "users" });
    for (const ufield of users?.fields || []) {
      if (ufield.is_fkey && ufield.reftable_name === this.name) {
        opts.push({
          label: `users.${ufield.label} [Key to ${this.name}]`,
          value: `Fml:user.${ufield.name}===id /* users.${ufield.label} */`,
        });
      }
    }
    // inherit from all my fks if table has ownership
    for (const field of fields) {
      if (field.is_fkey && field.reftable_name) {
        const refTable = Table.findOne({ name: field.reftable_name });

        if (refTable?.ownership_field_id) {
          //todo find in table.fields so we dont hit db
          const ofield = await Field.findOne({
            id: refTable?.ownership_field_id,
          });
          if (ofield)
            opts.push({
              label: `Inherit ${field.label}`,
              value: `Fml:${field.name}?.${ofield.name}===user.id /* Inherit ${field.label} */`,
            });
        }
        if (refTable?.ownership_formula) {
          const refFml = removeComments(refTable.ownership_formula);
          if (refFml.startsWith("user.") && !refFml.includes(".includes(")) {
            for (const ufield of users?.fields || []) {
              if (
                ufield.is_fkey &&
                refFml.startsWith(`user.${ufield.name}===`)
              ) {
                const sides = refFml.split("===");
                const newFml = `${sides[0]}===${field.name}.${sides[1]}`;
                opts.push({
                  label: `Inherit ${field.label}`,
                  value: `Fml:${newFml} /* Inherit ${field.label} */`,
                });
              }
            }
          }
          if (refFml.endsWith("==user.id")) {
            const path = refTable.ownership_formula
              .replace("===user.id", "")
              .replace("==user.id", "")
              .split(".");
            const fldNms = new Set((refTable?.fields || []).map((f) => f.name));
            if (fldNms.has(path[0])) {
              opts.push({
                label: `Inherit ${field.label}`,
                value: `Fml:${field.name}?.${refFml} /* Inherit ${field.label} */`,
              });
            }
          }
          if (refFml.startsWith("user.") && refFml.includes(".includes(")) {
            const [_pre, post] = refFml.split(").includes(");
            const ref = post.substring(0, post.length - 1);
            if (ref === this.pk_name) {
              const fml = refFml.replace(
                `.includes(${this.pk_name})`,
                `.includes(${field.name})`
              );
              opts.push({
                label: `Inherit ${field.label}`,
                value: `Fml:${fml} /* Inherit ${field.label} */`,
              });
            } else {
              const fml = refFml.replace(
                `.includes(${ref})`,
                `.includes(${field.name}?.${ref})`
              );

              opts.push({
                label: `Inherit ${field.label}`,
                value: `Fml:${fml} /* Inherit ${field.label} */`,
              });
            }
          }
        }
      }
    }

    // get user groups
    const tables = await Table.find({}, { cached: true });
    for (const ugtable of tables) {
      if (ugtable.is_user_group) {
        // /user.usergroups_by_user.map(g=>g.group).includes(group)
        const ugfields = await ugtable.getFields();
        const ug_to_user = ugfields.find((f) => f.reftable_name === "users");
        if (!ug_to_user) continue;

        // direct field from user group to me
        const ug_to_me = ugfields.find((f) => f.reftable_name === this.name);
        if (ug_to_me) {
          opts.push({
            label: `In ${ugtable.name} user group by ${ug_to_me.label}`,
            value: `Fml:user.${sqlsanitize(ugtable.name)}_by_${
              ug_to_user.name
            }.map(g=>g.${ug_to_me.name}).includes(${
              this.pk_name
            }) /* User group ${ugtable.name} */`,
          });
        }

        // there is a field from this table to user group
        for (const field of fields) {
          if (field.is_fkey && field.reftable_name === ugtable.name) {
            //const to_me = ugfields.find((f) => f.reftable_name === "users");
            opts.push({
              label: `In ${ugtable.name} user group by ${field.label}`,
              value: `Fml:user.${ugtable.name}_by_${ug_to_user.name}.map(g=>g.${ugtable.pk_name}).includes(${field.name})`,
            });
          }
        }
      }
    }
    return opts;
  }

  /**
   * get sanitized name of table
   */
  get santized_name(): string {
    return sqlsanitize(this.name);
  }

  /**
   * extract primary key type name from fields
   * @param fields
   */
  private static pkSqlType(fields?: (FieldCfg | string)[]): {
    pk_type: string;
    pk_sql_type: string;
  } {
    let pk_type: string = "Integer";
    let pk_sql_type = db.isSQLite ? "integer" : "serial";
    if (fields && Array.isArray(fields)) {
      const pk_field = fields.find?.(
        (f) => typeof f !== "string" && f?.primary_key
      );
      pk_type =
        (typeof pk_field === "string"
          ? pk_field
          : typeof pk_field?.type === "string"
            ? pk_field?.type
            : pk_field?.type?.name) || "Integer";
    }
    if (pk_type !== "Integer") {
      const { getState } = require("../db/state");

      const type = getState().types[pk_type];
      pk_sql_type = type.sql_name;
      if (type.primaryKey?.default_sql)
        pk_sql_type = `${type.sql_name} default ${type.primaryKey?.default_sql}`;
    }
    return { pk_type, pk_sql_type };
  }

  /**
   * Create table
   * @param name - table name
   * @param options - table fields
   * @param id - optional id, if set, no '_sc_tables' entry is inserted
   * @returns {Promise<Table>} table
   */
  static async create(
    name: string,
    options: SelectOptions | TablePack = {}, //TODO not selectoptions
    id?: number
  ): Promise<Table> {
    const { pk_type, pk_sql_type } = Table.pkSqlType(options.fields);

    const schema = db.getTenantSchemaPrefix();
    // create table in database
    if (!options.provider_name)
      await db.query(
        `create table ${schema}"${sqlsanitize(
          name
        )}" (id ${pk_sql_type} primary key)`
      );
    // populate table definition row
    const tblrow = {
      name,
      versioned: options.versioned || false,
      has_sync_info: options.has_sync_info || false,
      min_role_read: options.min_role_read || 1,
      min_role_write: options.min_role_write || 1,
      ownership_field_id: options.ownership_field_id,
      ownership_formula: options.ownership_formula,
      description: options.description || "",
      provider_name: options.provider_name,
      provider_cfg: options.provider_cfg,
    };
    let pk_fld_id;
    if (!id) {
      // insert table definition into _sc_tables
      id = await db.insert("_sc_tables", tblrow);
      // add primary key column ID
      if (!options.provider_name) {
        const insfldres = await db.query(
          `insert into ${schema}_sc_fields(table_id, name, label, type, attributes, required, is_unique,primary_key)
            values($1,'id','ID','${pk_type}', '{}', true, true, true) returning id`,
          [id]
        );
        pk_fld_id = insfldres.rows[0].id;
      }
    }
    // create table
    //const provider = getState().table_providers[tbl.provider_name];
    //provider.get_table(tbl.provider_cfg, tbl);
    const fields = options?.provider_name
      ? [] //TODO look up
      : [
          new Field({
            type: pk_type,
            name: "id",
            label: "ID",
            primary_key: true,
            required: true,
            is_unique: true,
            table_id: id,
            id: pk_fld_id,
          }),
        ];
    const table = new Table({
      ...tblrow,
      id,
      fields,
    });

    // create table history
    if (table?.versioned) await table.create_history_table();
    // create sync info
    if (table.has_sync_info) await table.create_sync_info_table();
    // refresh tables cache
    //limited refresh if we do not have a client
    if (!db.getRequestContext()?.client)
      await require("../db/state").getState().refresh_tables(true);

    return table;
  }

  /**
   * Create the table structure
   * generates a CREATE TABLE cmd with all field and runs it
   * TODO field defaults for pg
   * @param table
   */
  static async createInDb(table: Table): Promise<void> {
    const is_sqlite = db.isSQLite;
    const schema = db.getTenantSchemaPrefix();
    const { pk_sql_type } = Table.pkSqlType(table.fields);
    const columnDefs = [`id ${pk_sql_type} primary key`];
    for (const f of table.fields) {
      if (f.primary_key) continue;
      if (!f.calculated || f.stored) {
        if (typeof f.attributes.default === "undefined") {
          columnDefs.push(
            `"${sqlsanitize(f.name)}" ${f.sql_type} ${
              f.required ? `not null ${is_sqlite ? 'default ""' : ""}` : ""
            }`
          );
        } else if (is_sqlite) {
          columnDefs.push(
            ` ${sqlsanitize(f.name)}  ${f.sql_type} ${
              f.required
                ? `not null default ${JSON.stringify(f.attributes.default)}`
                : ""
            } `
          );
        } else {
          // TODO pg (only sqlite for the mobile app)
        }
      }
    }
    const sql = `CREATE TABLE ${schema}"${sqlsanitize(
      table.name
    )}" ( ${columnDefs.join(", ")})`;
    await db.query(sql);
  }

  /**
   * Drop current table
   * @param only_forget boolean - if true that only
   * @returns {Promise<void>}
   */
  // tbd check all other tables related to table description
  async delete(only_forget: boolean = false): Promise<void> {
    const schema = db.getTenantSchemaPrefix();
    const is_sqlite = db.isSQLite;
    await this.update({ ownership_field_id: null });

    // drop table
    if (!only_forget)
      await db.query(
        `drop table if exists ${schema}"${sqlsanitize(this.name)}"`
      );
    // delete tag entries from _sc_tag_entries
    await db.deleteWhere("_sc_tag_entries", { table_id: this.id });
    // delete fields
    await db.query(`delete FROM ${schema}_sc_fields WHERE table_id = $1`, [
      this.id,
    ]);
    // delete table description
    await db.query(`delete FROM ${schema}_sc_tables WHERE id = $1`, [this.id]);
    // delete versioned table
    if (this.versioned)
      await db.query(
        `drop table if exists ${schema}"${sqlsanitize(this.name)}__history"`
      );
    //limited refresh if we do not have a client
    if (!db.getRequestContext()?.client)
      await require("../db/state").getState().refresh_tables(true);
  }

  /***
   * Get Table SQL Name
   * @type {string}
   */
  get sql_name(): string {
    return `${db.getTenantSchemaPrefix()}"${sqlsanitize(this.name)}"`;
  }

  /**
   * Reset Sequence
   */
  async resetSequence() {
    const fields = this.fields;
    const pk = fields.find((f) => f.primary_key);
    if (!pk) {
      throw new Error("Unable to find a field with a primary key.");
    }

    if (
      db.reset_sequence &&
      instanceOfType(pk.type) &&
      pk.type.name === "Integer"
    )
      await db.reset_sequence(this.name, this.pk_name);
  }

  /**
   * update Where with Ownership
   * @param where
   * @param fields
   * @param user
   * @param forRead
   */
  private updateWhereWithOwnership(
    where: Where,
    fields: Field[],
    user?: AbstractUser,
    forRead?: boolean
  ): { notAuthorized?: boolean } | undefined {
    const role = user?.role_id;
    const min_role = forRead ? this.min_role_read : this.min_role_write;
    if (
      role &&
      role > min_role &&
      ((!this.ownership_field_id && !this.ownership_formula) || role === 100)
    )
      return { notAuthorized: true };
    if (
      user &&
      role &&
      role < 100 &&
      role > min_role &&
      this.ownership_field_id
    ) {
      const owner_field = fields.find((f) => f.id === this.ownership_field_id);
      if (!owner_field)
        throw new Error(`Owner field in table ${this.name} not found`);
      mergeIntoWhere(where, {
        [owner_field.name]: user.id,
      });
    } else if (
      user &&
      role &&
      role < 100 &&
      role > min_role &&
      this.ownership_formula
    ) {
      try {
        mergeIntoWhere(where, this.ownership_formula_where(user));
      } catch (e) {
        //ignore, ownership formula is too difficult to merge with where
        // TODO user groups
      }
    }
  }

  private async addDeleteSyncInfo(ids: Row[], timestamp: Date): Promise<void> {
    if (ids.length > 0) {
      const schema = db.getTenantSchemaPrefix();
      const pkName = this.pk_name || "id";
      if (isNode()) {
        await db.query(
          `delete from ${schema}"${db.sqlsanitize(
            this.name
          )}_sync_info" where ref in (
            ${ids.map((row) => row[pkName]).join(",")})`
        );
        await db.query(
          `insert into ${schema}"${db.sqlsanitize(
            this.name
          )}_sync_info" values ${ids
            .map(
              (row) =>
                `(${row[pkName]}, date_trunc('milliseconds', to_timestamp( ${
                  timestamp.valueOf() / 1000.0
                } ) ), true)`
            )
            .join(",")}`
        );
      } else {
        await db.query(
          `update "${db.sqlsanitize(this.name)}_sync_info"
           set deleted = true, modified_local = true
           where ref in (${ids.map((row) => row[pkName]).join(",")})`
        );
      }
    }
  }

  /**
   * Delete rows from table. The first argument is a where expression indicating the conditions for the rows to be deleted
   *
   * @example
   * ```
   * // delete all books where author = "Friedrich Nietzsche"
   * await Table.findOne({name: "books"}).deleteRows({author: "Friedrich Nietzsche"})
   * ```
   *
   * @param where - condition
   * @param user - optional user, if null then no authorization will be checked
   * @returns
   */
  async deleteRows(where: Where, user?: AbstractUser, noTrigger?: boolean) {
    //Fast truncate if user is admin and where is blank
    const cfields = await Field.find(
      { reftable_name: this.name },
      { cached: true }
    );
    if (
      (!user || user?.role_id === 1) &&
      Object.keys(where).length == 0 &&
      db.truncate &&
      noTrigger &&
      !cfields.length
    ) {
      let done = false;
      await db.tryCatchInTransaction(async () => {
        await db.truncate(this.name);
        done = true;
      });
      if (done) return;
    }

    // get triggers on delete
    const triggers = await Trigger.getTableTriggers("Delete", this);
    const fields = this.fields;

    if (this.updateWhereWithOwnership(where, fields, user)?.notAuthorized) {
      const state = require("../db/state").getState();
      state.log(4, `Not authorized to deleteRows in table ${this.name}.`);
      return;
    }
    const calc_agg_fields = await Field.find(
      {
        calculated: true,
        stored: true,
        expression: "__aggregation",
        attributes: { json: { table: this.name } },
      },
      { cached: true }
    );
    let rows: any;
    if (
      calc_agg_fields.length ||
      (user && user.role_id > this.min_role_write && this.ownership_formula)
    ) {
      rows = await this.getJoinedRows({
        where,
        forUser: user,
        forPublic: !user,
      });
    }

    const deleteFileFields = fields.filter(
      (f) => f.type === "File" && f.attributes?.also_delete_file
    );
    const deleteFiles: Array<File> = [];
    if ((triggers.length > 0 || deleteFileFields.length > 0) && !noTrigger) {
      const File = require("./file");

      if (!rows)
        rows = await this.getJoinedRows({
          where,
        });
      for (const trigger of triggers) {
        for (const row of rows) {
          // run triggers on delete
          if (trigger.haltOnOnlyIf?.(row, user)) continue;
          await trigger.run!(row);
        }
      }
      if (isNode()) {
        for (const deleteFile of deleteFileFields) {
          for (const row of rows) {
            if (row[deleteFile.name]) {
              const file = await File.findOne({
                filename: row[deleteFile.name],
              });
              deleteFiles.push(file);
            }
          }
        }
      }
    }
    await db.tryCatchInTransaction(
      async () => {
        if (rows) {
          const delIds = rows.map((r: GenObj) => r[this.pk_name]);
          if (!db.isSQLite) {
            await db.deleteWhere(this.name, {
              [this.pk_name]: { in: delIds },
            });
          } else {
            await db.query(
              `delete from "${db.sqlsanitize(this.name)}" where "${db.sqlsanitize(
                this.pk_name
              )}" in (${delIds.join(",")})`
            );
          }
          for (const row of rows) await this.auto_update_calc_aggregations(row);
          if (this.has_sync_info) {
            const dbTime = await db.time();
            await this.addDeleteSyncInfo(rows, dbTime);
          }
        } else {
          const delIds = this.has_sync_info
            ? await db.select(this.name, where, {
                fields: [this.pk_name],
              })
            : null;

          await db.deleteWhere(this.name, where);
          if (this.has_sync_info) {
            const dbTime = await db.time();
            await this.addDeleteSyncInfo(delIds, dbTime);
          }
        }
        //if (fields.find((f) => f.primary_key)) await this.resetSequence();
        for (const file of deleteFiles) {
          await file.delete();
        }
      },
      (e: any) => {
        if (+e.code == 23503 && e.table) {
          const table = Table.findOne(e.table);
          const field = table?.fields.find(
            (f) => f.reftable_name === this.name && f.attributes.fkey_error_msg
          );
          // TODO there could in theory be multiple key fields onto this table.
          // check if e.constraint matches tableName_fieldName_fkey. if yes that is field
          if (field) throw new Error(field.attributes.fkey_error_msg);
          else throw e;
        } else throw e;
      }
    );
  }

  /**
   * Returns row with only fields that can be read from db (readFromDB flag)
   * @param row
   * @returns {*}
   */
  private readFromDB(row: Row): Row {
    if (this.fields) {
      for (const f of this.fields) {
        if (f.type && instanceOfType(f.type) && f.type.readFromDB)
          row[f.name] = f.type.readFromDB(row[f.name]);
      }
    }
    return row;
  }

  /**
   * Get one row from the table in the database. The matching row will be returned in a promise - use await to read the value.
   * If no matching rule can be found, null will be returned. If more than one row matches, the first found row
   * will be returned.
   *
   * The first argument to get row is a where-expression With the conditions the returned row should match.
   *
   * The second document is optional and is an object that can modify the search. This is mainly useful
   * in case there is more than one matching row for the where-expression in the first argument and you
   * want to give an explicit order. For example, use `{orderBy: "name"}` as the second argument to pick
   * the first row by the name field, ordered ascending. `{orderBy: "name", orderDesc: true}` to order by name,
   * descending
   *
   * This is however rare and usually getRow is run with a single argument of a
   * Where expression that uniquely determines the row to return, if it exisits.
   *
   * @example
   * ```
   * const bookTable = Table.findOne({name: "books"})
   *
   *
   * // get the row in the book table with id = 5
   * const myBook = await bookTable.getRow({id: 5})
   *
   * // get the row for the last book published by Leo Tolstoy
   * const myBook = await bookTable.getRow({author: "Leo Tolstoy"}, {orderBy: "published", orderDesc: true})
   * ```
   *
   * @param where
   * @param selopts
   * @returns {Promise<null|*>}
   */
  async getRow(
    where: Where = {},
    selopts: SelectOptions & ForUserRequest = {}
  ): Promise<Row | null> {
    const fields = this.fields;
    const { forUser, forPublic, ...selopts1 } = selopts;
    const role = forUser ? forUser.role_id : forPublic ? 100 : null;
    const row = await db.selectMaybeOne(
      this.name,
      where,
      this.processSelectOptions(selopts1)
    );
    if (!row || !this.fields) return null;
    if (role && role > this.min_role_read) {
      //check ownership
      if (forPublic) return null;
      else if (this.ownership_field_id) {
        const owner_field = fields.find(
          (f) => f.id === this.ownership_field_id
        );
        if (!owner_field)
          throw new Error(`Owner field in table ${this.name} not found`);
        if (row[owner_field.name] !== (forUser as AbstractUser).id) return null;
      } else if (this.ownership_formula || this.name === "users") {
        if (!this.is_owner(forUser, row)) return null;
      } else return null; //no ownership
    }
    return apply_calculated_fields(
      [this.readFromDB(this.parse_json_fields(row))],
      this.fields
    )[0];
  }

  /**
   * Get all matching rows from the table in the database.
   *
   * The arguments are the same as for getRow. The first argument is where-expression with the conditions to match,
   * and the second argument is an optional object and allows you to set ordering and limit options. Keywords that
   * can be used in the second argument are orderBy, orderDesc, limit and offset.
   *
   * getRows will return an array of rows matching the where-expression in the first argument, wrapped in a Promise
   * (use await to read the array).
   *
   * @example
   * ```
   * const bookTable = Table.findOne({name: "books"})
   *
   * // get the rows in the book table with author = "Henrik Pontoppidan"
   * const myBooks = await bookTable.getRows({author: "Henrik Pontoppidan"})
   *
   * // get the 3 most recent books written by "Henrik Pontoppidan" with more than 500 pages
   * const myBooks = await bookTable.getRows({author: "Henrik Pontoppidan", pages: {gt: 500}}, {orderBy: "published", orderDesc: true})
   * ```
   *
   * @param where
   * @param selopts
   * @returns {Promise<void>}
   */
  async getRows(
    where: Where = {},
    selopts: SelectOptions & ForUserRequest = {}
  ): Promise<Row[]> {
    const fields = this.fields;
    if (!this.fields) return [];
    const { forUser, forPublic, ...selopts1 } = selopts;
    const role = forUser ? forUser.role_id : forPublic ? 100 : null;
    if (
      role &&
      this.updateWhereWithOwnership(
        where,
        fields,
        forUser || { role_id: 100 },
        true
      )?.notAuthorized
    ) {
      return [];
    }

    let rows = await db.select(
      this.name,
      where,
      this.processSelectOptions(selopts1)
    );
    if (role && role > this.min_role_read) {
      //check ownership
      if (forPublic) return [];
      else if (this.ownership_field_id) {
        //already dealt with by changing where
      } else if (this.ownership_formula || this.name === "users") {
        rows = rows.filter((row: Row) => this.is_owner(forUser, row));
      } else return []; //no ownership
    }

    return apply_calculated_fields(
      rows.map((r: Row) => this.readFromDB(this.parse_json_fields(r))),
      this.fields,
      !!selopts.ignore_errors
    );
  }

  processSelectOptions(
    selopts: SelectOptions & ForUserRequest = {}
  ): SelectOptions & ForUserRequest {
    if (
      typeof selopts?.orderBy === "object" &&
      "operator" in selopts?.orderBy &&
      typeof selopts.orderBy.operator === "string"
    ) {
      const field = this.getField(selopts.orderBy.field);
      if (!instanceOfType(field?.type)) return selopts;
      const operator =
        field?.type?.distance_operators?.[selopts.orderBy.operator];
      selopts.orderBy.operator = operator;
    }
    return selopts;
  }

  /**
   * Count the number of rows in db table. The argument is a where-expression with conditions the
   * counted rows should match. countRows returns the number of matching rows wrapped in a promise.
   *
   * @example
   * ```
   * const bookTable = Table.findOne({name: "books"})
   *
   * // Count the total number of rows in the books table
   * const totalNumberOfBooks = await bookTable.countRows({})
   *
   * // Count the number of books where the cover_color field has the value is "Red"
   * const numberOfRedBooks = await bookTable.countRows({cover_color: "Red"})
   *
   * // Count number of books with more than 500 pages
   * const numberOfLongBooks = await bookTable.countRows({pages: {gt: 500}})
   * ```
   * @param where
   * @returns {Promise<number>}
   */
  async countRows(where?: Where, opts?: ForUserRequest): Promise<number> {
    return await db.count(this.name, where);
  }

  /**
   * Return distinct Values for column in table
   * ????
   * @param fieldnm
   * @returns {Promise<Object[]>}
   */
  async distinctValues(fieldnm: string, whereObj?: Where): Promise<any[]> {
    if (whereObj) {
      const { where, values } = mkWhere(whereObj, db.isSQLite);
      const res = await db.query(
        `select distinct "${db.sqlsanitize(fieldnm)}" from ${
          this.sql_name
        } ${where} order by "${db.sqlsanitize(fieldnm)}"`,
        values
      );
      return res.rows.map((r: Row) => r[fieldnm]);
    } else {
      const res = await db.query(
        `select distinct "${db.sqlsanitize(fieldnm)}" from ${
          this.sql_name
        } order by "${db.sqlsanitize(fieldnm)}"`
      );
      return res.rows.map((r: Row) => r[fieldnm]);
    }
  }

  /**
   *
   */
  private storedExpressionJoinFields() {
    let freeVars: Set<string> = new Set([]);
    for (const f of this.fields!)
      if (f.calculated && f.stored && f.expression)
        freeVars = new Set([...freeVars, ...freeVariables(f.expression)]);
    const joinFields = {};
    const { add_free_variables_to_joinfields } = require("../plugin-helper");
    add_free_variables_to_joinfields(freeVars, joinFields, this.fields);
    return joinFields;
  }

  /**
   * Update a single row in the table database.
   *
   * The first two arguments are mandatory. The first is an object with the new values to set in the row.
   * The second argument is the value of the primary key of the row to update. Typically this is the id
   * field of an existing row object
   *
   * @example
   * ```
   * const bookTable = Table.findOne({name: "books"})
   *
   * // get the row in the book table for Moby Dick
   * const moby_dick = await bookTable.getRow({title: "Moby Dick"})
   *
   * // Update the read field to true and the rating field to 5
   * await bookTable.updateRow({read: true, rating: 5}, moby_dick.id)
   *
   * // if you want to update more than one row, you must first retrieve all the rows and
   * // then update them individually
   *
   * const allBooks = await bookTable.getRows()
   * for(const book of allBooks) {
   *   await bookTable.updateRow({price: book.price*0.8}, book.id)
   * }
   * ```
   * @param v_in - columns with values to update
   * @param id - id value
   * @param _userid - user id
   * @param noTrigger
   * @param resultCollector
   * @returns
   */
  async updateRow(
    v_in: Row,
    id: PrimaryKeyValue,
    user?: AbstractUser,
    noTrigger?:
      | boolean
      | {
          noTrigger?: boolean;
          resultCollector?: object;
          restore_of_version?: number;
          syncTimestamp?: Date;
          additionalTriggerValues?: Row;
          autoRecalcIterations?: number;
        },
    resultCollector?: object,
    restore_of_version?: number,
    syncTimestamp?: Date,
    additionalTriggerValues?: Row,
    autoRecalcIterations?: number
  ): Promise<string | void> {
    // migrating to options arg
    if (typeof noTrigger === "object") {
      const extraOptions = noTrigger;
      resultCollector = extraOptions.resultCollector;
      restore_of_version = extraOptions.restore_of_version;
      syncTimestamp = extraOptions.syncTimestamp;
      additionalTriggerValues = extraOptions.additionalTriggerValues;
      autoRecalcIterations = extraOptions.autoRecalcIterations;
      noTrigger = extraOptions.noTrigger;
    }

    if (typeof autoRecalcIterations === "number" && autoRecalcIterations > 5)
      return;
    let existing: Row | undefined | null;
    let changedFromCalc = new Set([]);
    let v = { ...v_in };
    //these may have changed
    let changedFieldNames = new Set([
      ...Object.keys(v_in),
      ...this.fields.filter((f) => f.calculated).map((f) => f.name),
    ]);
    const fields = this.fields;
    const pk_name = this.pk_name;
    const role = user?.role_id;
    const state = require("../db/state").getState();
    let stringified = false;
    const sqliteJsonCols = !isNode()
      ? {
          jsonCols: this.fields
            .filter(
              (f) => typeof f.type !== "string" && f.type?.name === "JSON"
            )
            .map((f) => f.name),
        }
      : {};
    if (typeof id === "undefined")
      throw new Error(
        this.name + " updateRow called without primary key value"
      );
    if (id === null)
      throw new Error(
        this.name + " updateRow called with null as primary key value"
      );

    // normalise id passed from expanded join field
    if (typeof id === "object") id = id[this.pk_name];

    this.normalise_fkey_values(v);

    let joinFields = {} as JoinFields;
    if (fields.some((f: Field) => f.calculated && f.stored)) {
      joinFields = this.storedExpressionJoinFields();
    }
    if (this.ownership_formula)
      add_free_variables_to_joinfields(
        freeVariables(this.ownership_formula),
        joinFields,
        fields
      );
    if (
      user &&
      role &&
      (role > this.min_role_write || role > this.min_role_read)
    ) {
      if (role === 100) return "Not authorized"; //no possibility of ownership
      if (this.ownership_field_id) {
        const owner_field = fields.find(
          (f) => f.id === this.ownership_field_id
        );
        if (!owner_field)
          throw new Error(`Owner field in table ${this.name} not found`);
        if (v[owner_field.name] && v[owner_field.name] != user.id) {
          state.log(
            4,
            `Not authorized to updateRow in table ${this.name}. ${user.id} does not match owner field in updates`
          );
          return "Not authorized";
        }

        //need to check existing
        if (!existing)
          existing = await this.getJoinedRow({
            where: { [pk_name]: id },
            forUser: user,
            joinFields,
          });
        if (!existing || existing?.[owner_field.name] !== user.id) {
          state.log(
            4,
            `Not authorized to updateRow in table ${this.name}. ${user.id} does not match owner field in exisiting`
          );
          return "Not authorized";
        }
      }
      if (this.ownership_formula) {
        if (!existing)
          existing = await this.getJoinedRow({
            where: { [pk_name]: id },
            forUser: user,
            joinFields,
          });

        if (!existing || !this.is_owner(user, existing)) {
          state.log(
            4,
            `Not authorized to updateRow in table ${
              this.name
            }. User does not match formula: ${JSON.stringify(user)}`
          );
          return "Not authorized";
        }
      }
      if (!this.ownership_field_id && !this.ownership_formula) {
        state.log(
          4,
          `Not authorized to updateRow in table ${this.name}. No ownership`
        );
        return "Not authorized";
      }
    }
    if (this.constraints.filter((c) => c.type === "Formula").length) {
      if (!existing)
        existing = await this.getJoinedRow({
          where: { [pk_name]: id },
          forUser: user,
          joinFields,
        });
      const newRow = { ...existing, ...v };
      let constraint_check = this.check_table_constraints(newRow);
      if (constraint_check) return constraint_check;
    }
    if (user) {
      let field_write_check = this.check_field_write_role(v, user);
      if (field_write_check) return field_write_check;
    }

    //check validation here
    if (Trigger.hasTableTriggers("Validate", this)) {
      if (!existing)
        existing = await this.getJoinedRow({
          where: { [pk_name]: id },
          forUser: user,
          joinFields,
        });
      const valResCollector = resultCollector || {};
      await Trigger.runTableTriggers(
        "Validate",
        this,
        { ...(additionalTriggerValues || {}), ...existing, ...v },
        valResCollector,
        user,
        { old_row: existing, updated_fields: v_in }
      );
      if ("error" in valResCollector) return valResCollector.error as string;
      if ("set_fields" in valResCollector)
        Object.assign(v, valResCollector.set_fields);
    }

    if (fields.some((f: Field) => f.calculated && f.stored)) {
      //if any freevars are join fields, update row in db first
      const freeVarFKFields = new Set(
        Object.values(joinFields).map((jf: JoinField) => jf.ref)
      );
      let need_to_update = Object.keys(v_in).some((k) =>
        freeVarFKFields.has(k)
      );
      existing = await this.getJoinedRow({
        where: { [pk_name]: id },
        forUser: user,
        joinFields,
      });
      let updated;
      if (need_to_update) {
        state.log(
          6,
          `Updating ${this.name} because calculated fields: ${JSON.stringify(
            v
          )}, id=${id}`
        );
        this.stringify_json_fields(v);
        stringified = true;
        await db.update(this.name, v, id, {
          pk_name,
          ...sqliteJsonCols,
        });
        updated = await this.getJoinedRow({
          where: { [pk_name]: id },
          forUser: user,
          joinFields,
        });
      }

      let calced = await apply_calculated_fields_stored(
        need_to_update ? updated || {} : { ...existing, ...v_in },
        this.fields,
        this
      );

      for (const f of fields)
        if (f.calculated && f.stored) {
          if (
            typeof f.type !== "string" &&
            f.type?.name === "JSON" &&
            stringified &&
            !db.isSQLite
          ) {
            v[f.name] = JSON.stringify(calced[f.name]);
          } else v[f.name] = calced[f.name];
        }
    }

    if (this.versioned) {
      const existing1 = await db.selectOne(this.name, { [pk_name]: id });
      if (!existing) existing = existing1;
      //store all changes EXCEPT users with only last_mobile_login
      if (
        !(
          this.name === "users" &&
          Object.keys(v_in).length == 1 &&
          v_in.last_mobile_login
        )
      )
        await this.insert_history_row({
          ...existing1,
          ...v,
          [pk_name]: id,
          _version: {
            next_version_by_id: id,
            pk_name,
          },
          _time: new Date(),
          _userid: user?.id,
          _restore_of_version: restore_of_version || null,
        });
    }
    if (typeof existing === "undefined") {
      const triggers = await Trigger.getTableTriggers("Update", this);
      if (triggers.length > 0)
        existing = await this.getJoinedRow({
          where: { [pk_name]: id },
          forUser: user,
          joinFields,
        });
    }
    state.log(6, `Updating ${this.name}: ${JSON.stringify(v)}, id=${id}`);
    if (!stringified) this.stringify_json_fields(v);
    const really_changed_field_names: Set<string> = existing
      ? new Set(Object.keys(v).filter((k) => v[k] !== (existing as Row)[k]))
      : changedFieldNames;
    let keyChanged = false;
    for (const fnm of really_changed_field_names || []) {
      const field = this.getField(fnm);
      if (field?.is_fkey) {
        keyChanged = true;
        break;
      }
    }
    if (!existing && really_changed_field_names.size && keyChanged)
      existing = await this.getJoinedRow({
        where: { [pk_name]: id },
        forUser: user,
        joinFields,
      });
    await db.update(this.name, v, id, {
      pk_name,
      ...sqliteJsonCols,
    });

    if (this.has_sync_info) {
      const oldInfo = await this.latestSyncInfo(id);
      if (oldInfo && !oldInfo.deleted)
        await this.updateSyncInfo(id, oldInfo.last_modified, syncTimestamp);
      else await this.insertSyncInfo(id, syncTimestamp);
    }
    const newRow = { ...existing, ...v, [pk_name]: id };
    if (really_changed_field_names.size > 0) {
      await this.auto_update_calc_aggregations(
        newRow,
        !existing,
        (autoRecalcIterations || 0) + 1,
        really_changed_field_names,
        keyChanged
      );
      if (existing && keyChanged)
        await this.auto_update_calc_aggregations(
          existing,
          !existing,
          (autoRecalcIterations || 0) + 1,
          really_changed_field_names,
          keyChanged
        );
    }

    if (!noTrigger) {
      const trigPromise = Trigger.runTableTriggers(
        "Update",
        this,
        { ...(additionalTriggerValues || {}), ...newRow },
        resultCollector,
        role === 100 ? undefined : user,
        { old_row: existing, updated_fields: v_in }
      );
      if (resultCollector) await trigPromise;
    }
  }

  async insert_history_row(v0: Row, retry = 0) {
    // sometimes there is a race condition in history inserts
    // https://dba.stackexchange.com/questions/212580/concurrent-transactions-result-in-race-condition-with-unique-constraint-on-inser
    // solution: retry 3 times, if fails run with on conflict do nothing

    //legacy workaround: delete calc fields which may be in row
    const calcFields = this.fields.filter((f) => f.calculated && !f.stored);
    const v1 = { ...v0 };
    calcFields.forEach((f) => {
      // delete v1[f.name];
    });
    if (this.name === "users") delete v1.last_mobile_login;

    this.stringify_json_fields(v1);

    const id = await db.insert(this.name + "__history", v1, {
      onConflictDoNothing: true,
      pk_name: this.pk_name,
    });
    if (!id && retry <= 3) await this.insert_history_row(v1, retry + 1);
  }

  async latestSyncInfo(id: PrimaryKeyValue) {
    const rows = await this.latestSyncInfos([id]);
    return rows?.length === 1 ? rows[0] : null;
  }

  async latestSyncInfos(ids: PrimaryKeyValue[]) {
    const schema = db.getTenantSchemaPrefix();
    const dbResult = await db.query(
      `select max(last_modified) "last_modified", ref
       from ${schema}"${db.sqlsanitize(this.name)}_sync_info"
       group by ref having ref = ${db.isSQLite ? "" : "ANY"} ($1)`,
      db.isSQLite ? ids : [ids]
    );
    return dbResult.rows;
  }

  private async insertSyncInfo(id: PrimaryKeyValue, syncTimestamp?: Date) {
    const schema = db.getTenantSchemaPrefix();
    if (isNode()) {
      await db.query(
        `insert into ${schema}"${db.sqlsanitize(
          this.name
        )}_sync_info" values($1,
        date_trunc('milliseconds', to_timestamp($2)))`,
        [
          id,
          (syncTimestamp ? syncTimestamp : await db.time()).valueOf() / 1000.0,
        ]
      );
    } else {
      await db.query(
        `insert into "${db.sqlsanitize(this.name)}_sync_info"
         (ref, modified_local, deleted) 
         values('${id}', true, false)`
      );
    }
  }

  private async updateSyncInfo(
    id: PrimaryKeyValue,
    oldLastModified: Date,
    syncTimestamp?: Date
  ) {
    const schema = db.getTenantSchemaPrefix();
    if (!db.isSQLite) {
      await db.query(
        `update ${schema}"${db.sqlsanitize(
          this.name
        )}_sync_info" set last_modified=date_trunc('milliseconds', to_timestamp($1)) where ref=$2 and last_modified = to_timestamp($3)`,
        [
          (syncTimestamp ? syncTimestamp : await db.time()).valueOf() / 1000.0,
          id,
          oldLastModified.valueOf() / 1000.0,
        ]
      );
    } else {
      await db.query(
        `update "${db.sqlsanitize(
          this.name
        )}_sync_info" set modified_local = true 
         where ref = ${id} and last_modified = ${
           oldLastModified ? oldLastModified.valueOf() : "null"
         }`
      );
    }
  }

  /**
   * Try to Update row
   * @param v
   * @param id
   * @param _userid
   * @param resultCollector
   * @returns {Promise<{error}|{success: boolean}>}
   */
  async tryUpdateRow(
    v: Row,
    id: PrimaryKeyValue,
    user?: AbstractUser,
    resultCollector?: object
  ): Promise<ResultMessage> {
    try {
      const maybe_err = await this.updateRow(
        v,
        id,
        user,
        false,
        resultCollector
      );
      if (typeof maybe_err === "string") return { error: maybe_err };
      else return { success: true };
    } catch (e) {
      return { error: this.normalise_error_message((e as ErrorObj).message) };
    }
  }

  /**
   * ????
   * @param id
   * @param field_name
   * @returns {Promise<void>}
   */
  async toggleBool(
    id: PrimaryKeyValue,
    field_name: string,
    user?: AbstractUser
  ): Promise<void> {
    const row = await this.getRow({ [this.pk_name]: id });
    if (row) await this.updateRow({ [field_name]: !row[field_name] }, id, user);
  }

  /**
   * Get primary key field name
   * @type {string}
   */
  get pk_name(): string {
    const pkField = this.fields?.find((f: Field) => f.primary_key)?.name;
    if (!pkField) {
      throw new Error(`A primary key field is mandatory (Table ${this.name})`);
    }
    return pkField;
  }

  get pk_type(): Type {
    const pkField = this.fields?.find((f: Field) => f.primary_key);
    if (!pkField) {
      throw new Error(`A primary key field is mandatory (Table ${this.name})`);
    }
    if (!instanceOfType(pkField.type)) {
      throw new Error(
        `A primary key field must have a type (Table ${this.name})`
      );
    }
    return pkField.type;
  }

  /**
   * Check table constraints against a row object. Will return a string With an error message if the
   * table constraints are violated, `undefined` if the row does not violate any constraints
   *
   * @param row
   */

  check_table_constraints(row0: Row): string | undefined {
    const row = { ...row0 };
    this.fields.forEach((f) => {
      if (typeof row[f.name] === "undefined") row[f.name] = null;
    });

    const fmls = this.constraints
      .filter((c) => c.type === "Formula")
      .map((c) => c.configuration);
    for (const { formula, errormsg } of fmls) {
      if (!eval_expression(formula, row, undefined, "Contraint formula"))
        return errormsg;
    }
    return undefined;
  }

  /**
   *
   * @param row
   * @param user
   */
  private check_field_write_role(
    row: Row,
    user: AbstractUser
  ): string | undefined {
    for (const field of this.fields) {
      if (
        typeof row[field.name] !== "undefined" &&
        field.attributes?.min_role_write &&
        user.role_id > +field.attributes?.min_role_write
      )
        return "Not authorized";
    }
    return undefined;
  }

  normalise_fkey_values(v_in: Row) {
    for (const field of this.fields)
      if (
        field.is_fkey &&
        v_in[field.name] &&
        typeof v_in[field.name] === "object"
      ) {
        //get pkey
        const pk = Table.findOne({ name: field.reftable_name })?.pk_name;
        if (pk) v_in[field.name] = v_in[field.name][pk];
      }
  }

  /**
   * Insert row into the table. By passing in the user as
   * the second argument, it will check write rights. If a user object is not
   * supplied, the insert goes ahead without checking write permissions.
   *
   * Returns the primary key value of the inserted row.
   *
   * This will throw an exception if the row
   * does not conform to the table constraints. If you would like to insert a row
   * with a function that can return an error message, use {@link Table.tryInsertRow} instead.
   *
   * @example
   * ```
   * await Table.findOne("People").insertRow({ name: "Jim", age: 35 })
   * ```
   *
   * @param v_in
   * @param user
   * @param resultCollector
   * @returns {Promise<*>}
   */
  async insertRow(
    v_in0: Row,
    user?: AbstractUser,
    resultCollector?: object,
    noTrigger?: boolean,
    syncTimestamp?: Date
  ): Promise<any> {
    const v_in = { ...v_in0 };
    const fields = this.fields;
    const pk_name = this.pk_name;
    const joinFields = this.storedExpressionJoinFields();
    if (this.ownership_formula)
      add_free_variables_to_joinfields(
        freeVariables(this.ownership_formula),
        joinFields,
        fields
      );
    let v, id;
    const state = require("../db/state").getState();
    const sqliteJsonCols = !isNode()
      ? {
          jsonCols: this.fields
            .filter(
              (f) => typeof f.type !== "string" && f.type?.name === "JSON"
            )
            .map((f) => f.name),
        }
      : {};

    this.normalise_fkey_values(v_in);

    if (user && user.role_id > this.min_role_write) {
      if (this.ownership_field_id) {
        const owner_field = fields.find(
          (f) => f.id === this.ownership_field_id
        );
        if (!owner_field)
          throw new Error(`Owner field in table ${this.name} not found`);
        if (v_in[owner_field.name] != user.id) {
          state.log(
            4,
            `Not authorized to insertRow in table ${this.name}. ${user.id} does not match owner field`
          );

          return;
        }
      }
      if (!this.ownership_field_id && !this.ownership_formula) {
        state.log(
          4,
          `Not authorized to insertRow in table ${this.name}. No ownership.`
        );
        return;
      }
    }
    let constraint_check = this.check_table_constraints(v_in);
    if (constraint_check) throw new Error(constraint_check);
    if (user) {
      let field_write_check = this.check_field_write_role(v_in, user);
      if (field_write_check) return field_write_check;
    }
    //check validate here based on v_in
    const valResCollector: ResultType = resultCollector || {};
    await Trigger.runTableTriggers(
      "Validate",
      this,
      { ...v_in },
      valResCollector,
      user
    );
    if ("error" in valResCollector) return valResCollector; //???
    if ("set_fields" in valResCollector)
      Object.assign(v_in, valResCollector.set_fields);

    if (
      Object.keys(joinFields).length > 0 ||
      fields.some((f) => f.expression === "__aggregation")
    ) {
      state.log(
        6,
        `Inserting ${this.name} because join fields: ${JSON.stringify(v_in)}`
      );
      this.stringify_json_fields(v_in);
      id = await db.insert(this.name, v_in, { pk_name, ...sqliteJsonCols });
      let existing = await this.getJoinedRows({
        where: { [pk_name]: id },
        joinFields,
        forUser: user,
      });
      if (!existing?.[0]) {
        //failed ownership test
        if (id) await db.deleteWhere(this.name, { [pk_name]: id });
        state.log(
          4,
          `Not authorized to insertRow in table ${this.name}. Inserted row not retrieved.`
        );
        return;
      }

      let calced = await apply_calculated_fields_stored(
        existing[0],
        fields,
        this
      );
      v = { ...v_in };

      for (const f of fields)
        if (f.calculated && f.stored) v[f.name] = calced[f.name];
      state.log(
        6,
        `Updating ${this.name} because join fields: ${JSON.stringify(v_in)}`
      );
      await db.update(this.name, v, id, { pk_name, ...sqliteJsonCols });
    } else {
      v = await apply_calculated_fields_stored(v_in, fields, this);
      this.stringify_json_fields(v);
      state.log(6, `Inserting ${this.name} row: ${JSON.stringify(v)}`);
      id = await db.insert(this.name, v, {
        pk_name,
        ...sqliteJsonCols,
      });
    }
    if (user && user.role_id > this.min_role_write && this.ownership_formula) {
      let existing = await this.getJoinedRow({
        where: { [pk_name]: id },
        joinFields,
        forUser: user,
      });

      if (!existing || !this.is_owner(user, existing)) {
        await this.deleteRows({ [pk_name]: id });
        state.log(
          4,
          `Not authorized to insertRow in table ${
            this.name
          }. User does not match formula: ${JSON.stringify(user)}`
        );
        return;
      }
    }
    if (this.versioned)
      await this.insert_history_row({
        ...v,
        [pk_name]: id,
        _version: {
          next_version_by_id: id,
          pk_name,
        },
        _userid: user?.id,
        _time: new Date(),
      });

    if (this.has_sync_info) {
      if (isNode()) {
        const schemaPrefix = db.getTenantSchemaPrefix();
        await db.query(
          `insert into ${schemaPrefix}"${db.sqlsanitize(this.name)}_sync_info"
           values(${id}, date_trunc('milliseconds', to_timestamp(${
             (syncTimestamp ? syncTimestamp : await db.time()).valueOf() /
             1000.0
           })))`
        );
      } else {
        await db.query(
          `insert into "${db.sqlsanitize(this.name)}_sync_info"
           (last_modified, ref, modified_local, deleted)
           values(NULL, ${id}, true, false)`
        );
      }
    }
    const newRow = { [pk_name]: id, ...v };
    await this.auto_update_calc_aggregations(newRow);
    if (!noTrigger) {
      apply_calculated_fields([newRow], this.fields);
      const trigPromise = Trigger.runTableTriggers(
        "Insert",
        this,
        newRow,
        resultCollector,
        user
      );
      if (resultCollector) await trigPromise;
    }
    return id;
  }

  private async auto_update_calc_aggregations(
    v0: Row,
    refetch?: boolean,
    iterations: number = 1,
    changedFields?: Set<string>,
    keyChanged: boolean = false
  ) {
    const state = require("../db/state").getState();
    const pk_name = this.pk_name;
    state.log(
      6,
      `auto_update_calc_aggregations table=${this.name} id=${
        v0[pk_name]
      } iters=${iterations}${
        changedFields ? ` changedFields=${[...(changedFields || [])]}` : ""
      }`
    );
    if (iterations > 5) return;
    const calc_agg_fields = await Field.find(
      {
        calculated: true,
        stored: true,
        expression: "__aggregation",
        attributes: { json: { table: this.name } },
      },
      { cached: true }
    );
    const calc_join_agg_fields = await Field.find(
      {
        calculated: true,
        stored: true,
        expression: "__aggregation",
        attributes: { json: { table: { ilike: `->${this.name}` } } },
      },
      { cached: true }
    );

    let v = v0;
    if (refetch && (calc_agg_fields.length || calc_join_agg_fields.length)) {
      v = (await this.getJoinedRow({
        where: { [pk_name]: v0[pk_name] },
      })) as Row;
    }

    //track which rows in which tables are updated
    const updated: { [k: string]: Set<PrimaryKeyValue> } = {};

    for (const calc_field of calc_agg_fields) {
      const agg_field_name = calc_field.attributes.agg_field.split("@")[0];
      if (changedFields && !changedFields.has(agg_field_name) && !keyChanged)
        continue;

      const refTable = Table.findOne({ id: calc_field.table_id });
      if (!refTable || !v[calc_field.attributes.ref]) continue;
      const val0 = v[calc_field.attributes.ref];
      const val = typeof val0 === "object" ? val0[pk_name] : val0;
      const rows = await refTable?.getRows({
        [refTable.pk_name]: val,
      });
      if (!updated[refTable.name]) updated[refTable.name] = new Set();

      for (const row of rows) {
        if (!updated[refTable.name].has(row[refTable.pk_name])) {
          updated[refTable.name].add(row[refTable.pk_name]);
          await refTable?.updateRow?.(
            {},
            row[refTable.pk_name],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            iterations + 1
          );
        }
      }
    }
    for (const calc_field of calc_join_agg_fields) {
      const [joinField, thisName] = calc_field.attributes.table.split("->");
      const agg_field_name = calc_field.attributes.agg_field.split("@")[0];

      if (changedFields && !changedFields.has(agg_field_name)) continue;

      const refTable = Table.findOne({ id: calc_field.table_id });

      if (!refTable || !v[calc_field.attributes.ref]) continue;

      const val0 = v[calc_field.attributes.ref];
      const val = typeof val0 === "object" ? val0[pk_name] : val0;

      const rows = await refTable?.getRows({
        [joinField]: val,
      });
      if (!updated[refTable.name]) updated[refTable.name] = new Set();

      for (const row of rows || []) {
        if (!updated[refTable.name].has(row[refTable.pk_name])) {
          updated[refTable.name].add(row[refTable.pk_name]);
          await refTable?.updateRow?.(
            {},
            row[refTable.pk_name],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            iterations + 1
          );
        }
      }
    }

    // expressions involving joinfields. uses attribute set by
    // Field.set_calc_joinfields
    const stored_fields = await Field.find(
      {
        calculated: true,
        stored: true,
      },
      { cached: true }
    );
    for (const field of stored_fields) {
      if (!field.attributes.calc_joinfields) continue;
      const matchings = field.attributes.calc_joinfields.filter(
        (jf: CalcJoinfield) => jf.targetTable === this.name
      );
      if (!matchings.length) continue;
      const refTable =
        (field.table as Table) || Table.findOne({ id: field.table_id });
      if (!updated[refTable.name]) updated[refTable.name] = new Set();

      for (const matching of matchings) {
        //console.log({ matching, changedFields });
        if (
          changedFields &&
          matching.targetField &&
          !changedFields.has(matching.targetField)
        )
          continue;
        if (matching.through?.length === 1) {
          // select readings where patient_id.favbook = v.id
          // select reftable where field.through[0] = v.id
          const rows = await refTable!.getRows({
            [matching.field]: {
              inSelect: {
                table: matching.throughTable[0],
                field: Table.findOne(matching.throughTable[0])?.pk_name || "id",
                tenant: db.isSQLite ? undefined : db.getTenantSchema(),
                where: { [matching.through[0]]: v[this.pk_name] },
              },
            },
          });
          for (const row of rows)
            if (!updated[refTable.name].has(row[refTable.pk_name])) {
              updated[refTable.name].add(row[refTable.pk_name]);
              await refTable?.updateRow?.(
                {},
                row[refTable.pk_name],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                iterations + 1
              );
            }
        } else {
          //no through
          const rows = await refTable!.getRows({
            [matching.field]: v[this.pk_name],
          });
          for (const row of rows) {
            if (!updated[refTable.name].has(row[refTable.pk_name])) {
              updated[refTable.name].add(row[refTable.pk_name]);
              await refTable?.updateRow?.(
                {},
                row[refTable.pk_name],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                iterations + 1
              );
            }
          }
        }
      }
    }
  }

  /**
   * Try to Insert row
   * @param v
   * @param _userid
   * @param resultCollector
   * @returns {Promise<{error}|{success: *}>}
   */
  async tryInsertRow(
    v: Row,
    user?: AbstractUser,
    resultCollector?: object
  ): Promise<{ error: string } | { success: PrimaryKeyValue }> {
    try {
      const id = await this.insertRow(v, user, resultCollector);
      if (!id) return { error: "Not authorized" };
      if (id?.includes?.("Not authorized")) return { error: id };
      if (id?.error) return id;
      return { success: id };
    } catch (e) {
      await require("../db/state").getState().log(5, e);
      return { error: this.normalise_error_message((e as ErrorObj).message) };
    }
  }

  /**
   *
   * @param msg
   */
  normalise_error_message(msg: string): string {
    let fieldnm: string = "";
    if (msg.toLowerCase().includes("unique constraint")) {
      if (db.isSQLite) {
        fieldnm = msg.replace(
          `SQLITE_CONSTRAINT: UNIQUE constraint failed: ${this.name}.`,
          ""
        );
      } else {
        const m = msg.match(
          /duplicate key value violates unique constraint "(.*?)_(.*?)_unique"/
        );
        if (m) fieldnm = m[2];
      }
      if (fieldnm) {
        const field = this.fields.find((f) => f.name === fieldnm);
        if (field?.attributes?.unique_error_msg)
          return field?.attributes?.unique_error_msg;
        else {
          const tc_unique = this.constraints.find((c) => {
            if (c.type !== "Unique") return false;
            let conNm = "";
            if (db.isSQLite) {
              // SQLITE_CONSTRAINT: UNIQUE constraint failed: books.author, books.pages
              // first table name stripped by replace
              let [field1, ...rest_fields] = c.configuration.fields;
              conNm = [
                field1,
                ...rest_fields.map((fnm: string) => `${this.name}.${fnm}`),
              ].join(", ");
            } else {
              conNm = c.configuration.fields.join("_");
            }
            return c.configuration.errormsg && conNm === fieldnm;
          });

          if (tc_unique) return tc_unique.configuration.errormsg;
          return `Duplicate value for unique field: ${field?.label || fieldnm}`;
        }
      }
    }
    return msg;
  }

  /**
   * Get Fields list for table
   * @returns {Promise<Field[]>}
   */
  getFields(): Field[] {
    return this.fields;
  }

  /**
   * get foreign keys, without the 'File' type
   * @returns array of FK Fields
   */
  getForeignKeys(): Field[] {
    return this.fields.filter((f) => f.is_fkey && f.type !== "File");
  }

  /**
   * Get a field, possibly by relation
   * @returns {Promise<Field | undefined>}
   */
  getField(path: string): Field | undefined {
    const fields = this.fields;
    if (path.includes("->")) {
      const joinPath = path.split(".");
      const tableName = joinPath[0];
      const joinTable = Table.findOne({ name: tableName });
      if (!joinTable)
        throw new Error(`The table '${tableName}' does not exist.`);
      const joinedField = joinPath[1].split("->")[1];
      const fields = joinTable.getFields();
      return fields.find((f) => f.name === joinedField);
    } else if (path.includes(".")) {
      const keypath = path.split(".");
      let field,
        theFields = fields;
      for (let i = 0; i < keypath.length; i++) {
        const refNm = keypath[i];
        field = theFields.find((f) => f.name === refNm);
        if (!field || !field.reftable_name) break;
        const table = Table.findOne({ name: field.reftable_name });
        if (!table) break;
        theFields = table.fields;
      }
      return field;
    } else return fields.find((f) => f.name === path);
  }

  /**
   * Create history table
   * @returns {Promise<void>}
   */
  // todo create function that returns history table name for table
  private async create_history_table(): Promise<void> {
    const schemaPrefix = db.getTenantSchemaPrefix();

    const fields = [...this.fields];
    if (this.name === "users")
      fields.push(
        new Field({ name: "password", type: "String" }),
        new Field({ name: "reset_password_token", type: "String" }),
        new Field({ name: "reset_password_expiry", type: "Date" }),
        new Field({ name: "language", type: "String" }),
        new Field({ name: "disabled", type: "Bool" }),
        new Field({ name: "api_token", type: "String" }),
        new Field({ name: "verification_token", type: "String" }),
        new Field({ name: "verified_on", type: "Date" })

        // Not last_mobile_login - we do not want to store this in history.
        // Deleted in Table.insert_history_row instead
        //new Field({ name: "last_mobile_login", type: "Date" })
      );
    const flds = fields
      .filter((f) => !f.calculated || f.stored)
      .map((f: Field) => `,"${sqlsanitize(f.name)}" ${f.sql_bare_type}`);
    const pk = fields.find((f) => f.primary_key)?.name;
    if (!pk) {
      throw new Error("Unable to find a field with a primary key.");
    }

    // create history table
    await db.query(
      `create table ${schemaPrefix}"${sqlsanitize(this.name)}__history" (
          _version integer,
          _time timestamp,
          _restore_of_version integer,
          _userid integer
          ${flds.join("")}
          ${this.name === "users" ? ",_attributes JSONB" : ""}
          ,PRIMARY KEY("${pk}", _version)
          );`
    );
  }

  private async create_sync_info_table(): Promise<void> {
    const schemaPrefix = db.getTenantSchemaPrefix();
    const fields = this.fields;
    const pk = fields.find((f) => f.primary_key)?.name;
    if (!pk) {
      throw new Error("Unable to find a field with a primary key.");
    }
    await db.query(
      `create table ${schemaPrefix}"${sqlsanitize(
        this.name
      )}_sync_info" (ref integer, last_modified timestamp, deleted boolean default false)`
    );
    await db.query(
      `create index "${sqlsanitize(
        this.name
      )}_sync_info_ref_index" on ${schemaPrefix}"${sqlsanitize(
        this.name
      )}_sync_info"(ref)`
    );
    await db.query(
      `create index "${sqlsanitize(
        this.name
      )}_sync_info_lm_index" on ${schemaPrefix}"${sqlsanitize(
        this.name
      )}_sync_info"(last_modified)`
    );
    await db.query(
      `create index "${sqlsanitize(
        this.name
      )}_sync_info_deleted_index" on ${schemaPrefix}"${sqlsanitize(
        this.name
      )}_sync_info"(deleted)`
    );
  }

  private async drop_sync_table(): Promise<void> {
    const schemaPrefix = db.getTenantSchemaPrefix();
    await db.query(`
      drop table ${schemaPrefix}"${sqlsanitize(this.name)}_sync_info";`);
  }

  /**
   * Restore Row Version
   * @param id
   * @param version
   * @param user
   */
  async restore_row_version(
    id: PrimaryKeyValue,
    version: number,
    user?: AbstractUser
  ): Promise<void> {
    const row = await db.selectOne(`${db.sqlsanitize(this.name)}__history`, {
      [this.pk_name]: id,
      _version: version,
    });
    var r: Row = {};
    this.fields.forEach((f: Field) => {
      if (!f.calculated) r[f.name] = row[f.name];
    });
    //console.log("restore_row_version", r);

    await this.updateRow(r, id, user, false, undefined, version);
  }

  /**
   * Undo row chnages
   * @param id
   * @param user
   */
  async undo_row_changes(
    id: PrimaryKeyValue,
    user?: AbstractUser
  ): Promise<void> {
    const current_version_row = await db.selectMaybeOne(
      `${sqlsanitize(this.name)}__history`,
      { [this.pk_name]: id },
      { orderBy: "_version", orderDesc: true, limit: 1 }
    );
    //get max that is not a restore
    const last_non_restore = await db.selectMaybeOne(
      `${sqlsanitize(this.name)}__history`,
      {
        [this.pk_name]: id,
        _version: {
          lt: current_version_row._restore_of_version
            ? current_version_row._restore_of_version
            : current_version_row._version,
        },
      },
      { orderBy: "_version", orderDesc: true, limit: 1 }
    );
    if (last_non_restore) {
      await this.restore_row_version(id, last_non_restore._version, user);
    }
  }

  /**
   * Redo row changes
   * @param id
   * @param user
   */
  async redo_row_changes(
    id: PrimaryKeyValue,
    user?: AbstractUser
  ): Promise<void> {
    const current_version_row = await db.selectMaybeOne(
      `${sqlsanitize(this.name)}__history`,
      { [this.pk_name]: id },
      { orderBy: "_version", orderDesc: true, limit: 1 }
    );

    if (current_version_row._restore_of_version) {
      const next_version = await db.selectMaybeOne(
        `${sqlsanitize(this.name)}__history`,
        {
          [this.pk_name]: id,
          _version: {
            gt: current_version_row._restore_of_version,
          },
        },
        { orderBy: "_version", limit: 1 }
      );

      if (next_version) {
        await this.restore_row_version(id, next_version._version, user);
      }
    }
  }

  /**
   * Compress history by minimal interval and/or deleting unchanged rows. Can be called
   * with options object, or just minimal interval for legacy code
   */
  async compress_history(
    options: { interval_secs?: number; delete_unchanged?: boolean } | number
  ) {
    const interval_secs =
      typeof options === "number" ? options : options?.interval_secs;
    const schemaPrefix = db.getTenantSchemaPrefix();
    const pk = this.pk_name;

    if (typeof interval_secs === "number" && interval_secs > 0.199) {
      await db.query(`
      delete from ${schemaPrefix}"${sqlsanitize(this.name)}__history" 
        where ("${sqlsanitize(pk)}", _version) in (
          select h1."${sqlsanitize(pk)}", h1._version
          FROM ${schemaPrefix}"${sqlsanitize(this.name)}__history" h1
          JOIN ${schemaPrefix}"${sqlsanitize(
            this.name
          )}__history" h2 ON h1."${sqlsanitize(pk)}" = h2."${sqlsanitize(pk)}"
          AND h1._version < h2._version
          AND h1._time < h2._time
          AND h2._time - h1._time <= INTERVAL '${+interval_secs} seconds'
        );`);
    }
    if (typeof options === "object" && options?.delete_unchanged) {
      const isDistinct = this.fields
        .map((f) => `curr."${f.name}" IS DISTINCT FROM prev."${f.name}"`)
        .join(" OR ");
      await db.query(`
        WITH ordered_versions AS (
        SELECT *,
                ROW_NUMBER() OVER (ORDER BY "${pk}", "_version") AS rn
        FROM ${schemaPrefix}"${sqlsanitize(this.name)}__history"
        WHERE "${sqlsanitize(pk)}" IS NOT NULL
        ),
        paired AS (
        SELECT 
          curr."_version" AS this_version,
          prev."_version" AS prev_version,
          curr."${pk}" AS id,
          (${isDistinct}) AS is_changed
        FROM ordered_versions curr
        LEFT JOIN ordered_versions prev
          ON curr.rn = prev.rn + 1 AND curr."${pk}" = prev."${pk}"
        )     
        DELETE FROM ${schemaPrefix}"${sqlsanitize(this.name)}__history"
          where ("${sqlsanitize(pk)}", _version) in (select id, this_version from paired where not is_changed);`);
    }
  }
  /**
   * Drop history table
   * @returns {Promise<void>}
   */
  private async drop_history_table(): Promise<void> {
    const schemaPrefix = db.getTenantSchemaPrefix();

    await db.query(`
      drop table ${schemaPrefix}"${sqlsanitize(this.name)}__history";`);
  }

  /**
   * Rename table
   * @param new_name
   * @returns {Promise<void>}
   */
  async rename(new_name: string): Promise<void> {
    //in transaction
    if (db.isSQLite)
      throw new InvalidAdminAction("Cannot rename table on SQLite");
    const schemaPrefix = db.getTenantSchemaPrefix();

    //rename table
    await db.query(
      `alter table ${schemaPrefix}"${sqlsanitize(
        this.name
      )}" rename to "${sqlsanitize(new_name)}";`
    );
    //change refs
    await db.query(
      `update ${schemaPrefix}_sc_fields set reftable_name=$1 where reftable_name=$2`,
      [new_name, this.name]
    );
    //rename history
    if (this.versioned)
      await db.query(
        `alter table ${schemaPrefix}"${sqlsanitize(
          this.name
        )}__history" rename to "${sqlsanitize(new_name)}__history";`
      );
    //1. change record
    await this.update({ name: new_name });
    //limited refresh if we do not have a client
    if (!db.getRequestContext()?.client)
      await require("../db/state").getState().refresh_tables(true);
  }

  /**
   * Update Table description in _sc_table
   * Also creates / drops history table for table
   * @param new_table_rec
   * @returns {Promise<void>}
   */
  async update(new_table_rec: Partial<Table>): Promise<void> {
    if (new_table_rec.ownership_field_id === ("" as any))
      delete new_table_rec.ownership_field_id;
    const existing = Table.findOne({ id: this.id });
    if (!existing) {
      throw new Error(`Unable to find table with id: ${this.id}`);
    }
    const { external, fields, constraints, ...upd_rec } = new_table_rec;
    await db.update("_sc_tables", upd_rec, this.id);
    //limited refresh if we do not have a client
    if (!db.getRequestContext()?.client)
      await require("../db/state").getState().refresh_tables(true);
    const new_table = new Table({ ...this, ...upd_rec });
    if (!new_table) {
      throw new Error(`Unable to find table with id: ${this.id}`);
    } else {
      if (new_table.versioned && !existing.versioned) {
        await new_table.create_history_table();
      } else if (!new_table.versioned && existing.versioned) {
        await new_table.drop_history_table();
      }
      if (new_table.has_sync_info && !existing.has_sync_info) {
        await this.create_sync_info_table();
      } else if (!new_table.has_sync_info && existing.has_sync_info) {
        await new_table.drop_sync_table();
      }
      Object.assign(this, new_table_rec);
    }
  }

  static async state_refresh() {
    await require("../db/state").getState().refresh_tables();
  }

  /**
   * Get table history data
   * @param id
   * @returns {Promise<*>}
   */
  async get_history(id?: PrimaryKeyValue): Promise<Row[]> {
    return await db.select(
      `${sqlsanitize(this.name)}__history`,
      id ? { [this.pk_name]: id } : {},
      { orderBy: "_version" }
    );
  }

  /**
   * Enable constraints
   * @returns {Promise<void>}
   */
  async enable_fkey_constraints(): Promise<void> {
    const fields = this.fields;
    for (const f of fields) await f.enable_fkey_constraint(this);
  }

  /**
   * Table Create from CSV
   * @param name
   * @param filePath
   * @returns {Promise<{error: string}|{error: string}|{error: string}|{error: string}|{error: string}|{success: string}|{error: (string|string|*)}>}
   */
  static async create_from_csv(
    name: string,
    filePath: string
  ): Promise<ResultMessage> {
    let rows;
    const state = await require("../db/state").getState();
    try {
      let lines_limit = state.getConfig("csv_types_detection_rows", 500);
      if (!lines_limit || lines_limit < 0) lines_limit = 500; // default

      const s = await getLines(filePath, lines_limit);
      rows = await csvtojson().fromString(s); // t
    } catch (e) {
      return { error: `Error processing CSV file` };
    }
    const rowsTr = transposeObjects(rows);
    const table = await Table.create(name);
    //
    const isBools = state
      .getConfig("csv_bool_values", "true false yes no on off y n t f")
      .split(" ");
    const isValidJSON = (v: string) => {
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    };
    for (const [k, vs] of Object.entries(rowsTr)) {
      const required = (<any[]>vs).every((v) => v !== "");
      const nonEmpties = (<any[]>vs).filter((v) => v !== "");

      let type;
      if (
        nonEmpties.every((v) =>
          //https://www.postgresql.org/docs/11/datatype-boolean.html

          isBools.includes(v && v.toLowerCase && v.toLowerCase())
        )
      )
        type = "Bool";
      else if (nonEmpties.every((v) => !isNaN(v)))
        if (
          nonEmpties.every(
            (v) =>
              Number.isSafeInteger(+v) && v <= 2147483647 && v > -2147483648
          )
        )
          type = "Integer";
        else if (nonEmpties.every((v) => Number.isSafeInteger(+v)))
          type = "String";
        else type = "Float";
      else if (nonEmpties.every((v: any) => isDate(v))) type = "Date";
      else if (state.types.UUID && nonEmpties.every((v: any) => isValidUUID(v)))
        type = "UUID";
      else if (
        state.types.JSON &&
        nonEmpties.every(
          (v: any) =>
            typeof v === "string" &&
            (v[0] === "{" || v[0] === "[") &&
            isValidJSON(v)
        )
      )
        type = "JSON";
      else type = "String";
      const label = (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ");

      //can fail here if: non integer id, duplicate headers, invalid name

      const fld = new Field({
        name: Field.labelToName(k),
        required,
        type,
        table,
        label,
      });
      //console.log(fld);
      if (db.sqlsanitize(k.toLowerCase()) === "id") {
        if (db.isSQLite && type !== "Integer") {
          await table.delete();
          return { error: `Columns named "id" must have only integers` };
        }
        if (!required) {
          await table.delete();
          return { error: `Columns named "id" must not have missing values` };
        }
        if (
          typeof fld.type === "object" &&
          (fld.type.name === "String" || fld.type.name === "UUID")
        ) {
          const existing = table.getField("id")!;
          await existing.update({ type: fld.type.name });
        }
        continue;
      }
      if (db.sqlsanitize(fld.name) === "") {
        await table.delete();
        return {
          error: `Invalid column name ${k} - Use A-Z, a-z, 0-9, _ only`,
        };
      }
      try {
        await Field.create(fld);
      } catch (e) {
        await table.delete();
        return { error: `Error in header ${k}: ${(e as ErrorObj).message}` };
      }
    }
    const parse_res = await table.import_csv_file(filePath);
    if (instanceOfErrorMsg(parse_res)) {
      await table.delete();
      return { error: parse_res.error };
    }

    parse_res.table = table;
    //limited refresh if we do not have a client
    if (!db.getRequestContext()?.client)
      await require("../db/state").getState().refresh_tables(true);

    return parse_res;
  }

  /**
   *
   * @param state
   */
  read_state_strict(state: Row): Row | string {
    let errorString = "";
    this.fields.forEach((f) => {
      const current = state[f.name];
      //console.log(f.name, current, typeof current);

      if (typeof current !== "undefined") {
        if (instanceOfType(f.type) && f.type?.read) {
          const readval = f.type?.read(current, f.attributes);
          if (typeof readval === "undefined") {
            if (current === "" && !f.required) delete state[f.name];
            else errorString += `No valid value for required field ${f.name}. `;
          }
          if (f.type && f.type.validate) {
            const vres = f.type.validate(f.attributes || {})(readval);
            if (vres.error)
              errorString += `Validation error in field ${f.name}. `;
          }
          state[f.name] = readval;
        } else if (f.type === "Key")
          state[f.name] =
            current === "null" || current === "" || current === null
              ? null
              : +current;
        else if (f.type === "File")
          state[f.name] =
            current === "null" || current === "" || current === null
              ? null
              : current;
      } else if (f.required && !f.primary_key)
        errorString += `No valid value for required field ${f.name}. `;
    });
    return errorString || state;
  }

  async dump_to_json(filePath: string) {
    if (db.copyToJson) {
      await dump_table_to_json_file(filePath, this.name);
    } else {
      const rows = await this.getRows({}, { ignore_errors: true });
      await writeFile(filePath, JSON.stringify(rows));
    }
  }
  async dump_history_to_json(filePath: string) {
    if (db.copyToJson) {
      await dump_table_to_json_file(
        filePath,
        `${sqlsanitize(this.name)}__history`
      );
    } else {
      const rows = await this.get_history();
      await writeFile(filePath, JSON.stringify(rows));
    }
  }
  /**
   * Import CSV file to existing table
   * @param filePath
   * @param recalc_stored
   * @param skip_first_data_row
   * @returns {Promise<{error: string}|{success: string}>}
   */
  async import_csv_file(
    filePath: string,
    options?: {
      recalc_stored?: boolean;
      skip_first_data_row?: boolean;
      no_table_write?: boolean;
      no_transaction?: boolean;
      method?: "Auto" | "copy" | "row-by-row";
    }
  ): Promise<ResultMessage> {
    if (typeof options === "boolean") {
      options = { recalc_stored: options };
    }
    let headers: string[];
    let headerStr;
    try {
      headerStr = await getLines(filePath, 1);
      [headers] = await csvtojson({
        output: "csv",
        noheader: true,
      }).fromString(headerStr); // todo argument type unknown
    } catch (e) {
      return { error: `Error processing CSV file header: ${headerStr}` };
    }
    const fields = this.fields.filter((f) => !f.calculated);
    const okHeaders: any = {};
    const pk_name = this.pk_name;
    const renames: Array<{
      from: string;
      to: string;
    }> = [];
    const fkey_fields: Field[] = [];
    const json_schema_fields: Field[] = [];

    const state = require("../db/state").getState();

    for (const f of fields) {
      if (headers.includes(f.name)) okHeaders[f.name] = f;
      else if (headers.includes(f.label)) {
        okHeaders[f.label] = f;
        renames.push({ from: f.label, to: f.name });
      } else if (
        headers.map((h: string) => Field.labelToName(h)).includes(f.name)
      ) {
        okHeaders[f.name] = f;
        renames.push({
          from:
            headers.find((h: string) => Field.labelToName(h) === f.name) || "",
          to: f.name,
        });
      } else if (
        instanceOfType(f.type) &&
        f.type?.name === "JSON" &&
        headers.some((h) => h.startsWith(`${f.name}.`))
      ) {
        const hs = headers.filter((h) => h.startsWith(`${f.name}.`));
        hs.forEach((h) => {
          const f1 = new Field({
            ...f,
            attributes: structuredClone(f.attributes),
          });
          f1.attributes.subfield = h.replace(`${f.name}.`, "");
          okHeaders[h] = f1;
          json_schema_fields.push(f1);
        });
      } else if (f.required && !f.primary_key) {
        return { error: `Required field missing: ${f.label}` };
      }
      if (
        f.is_fkey &&
        (okHeaders[f.name] || okHeaders[f.label]) &&
        f.attributes.summary_field
      )
        fkey_fields.push(f);
    }
    const fieldNames = headers.map((hnm) => {
      if (okHeaders[hnm]) return okHeaders[hnm].name;
    });
    // also id
    // todo support uuid
    if (headers.includes(`id`)) okHeaders.id = { type: "Integer" };

    const renamesInv: {
      [k: string]: string | undefined;
    } = {};
    renames.forEach(({ from, to }) => {
      renamesInv[to] = from;
    });
    const colRe = new RegExp(
      `(${Object.keys(okHeaders)
        .map((k) => `^${renamesInv[k] || k}$`)
        .join("|")})`
    );

    let i = 1;
    let rejects = 0;
    let rejectDetails = "";
    const client =
      db.isSQLite || options?.no_transaction ? db : await db.getClient();

    const stats = await stat(filePath);
    const fileSizeInMegabytes = stats.size / (1024 * 1024);

    // start sql transaction
    if (!options?.no_transaction) await client.query("BEGIN");

    const readStream = createReadStream(filePath);
    const returnedRows: any = [];

    try {
      // for files more 1MB
      if (
        options?.method === "copy" ||
        (options?.method !== "row-by-row" &&
          db.copyFrom &&
          fileSizeInMegabytes > 1)
      ) {
        let theError;

        const copyres = await db
          .copyFrom(readStream, this.name, fieldNames, client)
          .catch((cate: Error) => {
            theError = cate;
          });
        if (theError || (copyres && copyres.error)) {
          theError = theError || copyres.error;
          return {
            error: `Error processing CSV file: ${
              !theError
                ? theError
                : theError.error || theError.message || theError
            }`,
          };
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          const imported_pk_set = new Set();
          const summary_field_cache: any = {};
          csvtojson({
            includeColumns: colRe,
          })
            .fromStream(readStream)
            .subscribe(
              async (rec: { [key: string]: any }) => {
                i += 1;
                if (options?.skip_first_data_row && i === 2) return;
                try {
                  renames.forEach(({ from, to }) => {
                    rec[to] = rec[from];
                    delete rec[from];
                  });

                  for (const jfield of json_schema_fields) {
                    const sf = jfield.attributes.subfield;
                    const jtype = jfield.attributes.schema.find(
                      ({ key }: { key: string }) => key === sf
                    );

                    if (rec[jfield.name][sf] === "")
                      delete rec[jfield.name][sf];
                    else if (
                      jtype?.type === "Integer" ||
                      jtype?.type === "Float"
                    ) {
                      rec[jfield.name][sf] = +rec[jfield.name][sf];
                      if (isNaN(rec[jfield.name][sf]))
                        delete rec[jfield.name][sf];
                    }
                  }

                  for (const fkfield of fkey_fields) {
                    const current = rec[fkfield.name];
                    if (
                      !(
                        current === "null" ||
                        current === "" ||
                        current === null
                      ) &&
                      isNaN(+current)
                    ) {
                      //need to look up summary fields
                      if (summary_field_cache[current])
                        rec[fkfield.name] = summary_field_cache[current];
                      else {
                        const tbl = Table.findOne({
                          name: fkfield.reftable_name,
                        });
                        const row = await tbl?.getRow({
                          [fkfield.attributes.summary_field]: current,
                        });
                        if (tbl && row) {
                          rec[fkfield.name] = row[tbl.pk_name];
                          summary_field_cache[current] = row[tbl.pk_name];
                        }
                      }
                      if (isNaN(+rec[fkfield.name])) {
                        rejectDetails += `Reject row ${i} because in field ${
                          fkfield.name
                        } value "${text(
                          current
                        )}" not matched by a value in table ${
                          fkfield.reftable_name
                        } field ${fkfield.attributes.summary_field}.\n`;
                        rejects += 1;
                        return;
                      }
                    }
                  }
                  const rowOk = this.read_state_strict(rec);

                  if (typeof rowOk !== "string") {
                    if (typeof rec[this.pk_name] !== "undefined") {
                      //TODO replace with upsert - optimisation
                      if (imported_pk_set.has(rec[this.pk_name]))
                        throw new Error(
                          "Duplicate primary key values: " + rec[this.pk_name]
                        );
                      imported_pk_set.add(rec[this.pk_name]);
                      const existing = await db.selectMaybeOne(this.name, {
                        [this.pk_name]: rec[this.pk_name],
                      });
                      this.stringify_json_fields(rec);
                      if (options?.no_table_write) {
                        if (existing) {
                          Object.entries(existing).forEach(([k, v]) => {
                            if (typeof rec[k] === "undefined") rec[k] = v;
                          });
                        }
                        returnedRows.push(rec);
                      } else if (existing)
                        await db.update(this.name, rec, rec[this.pk_name], {
                          pk_name,
                          client,
                        });
                      else
                        try {
                          // TODO check constraints???
                          await db.insert(this.name, rec, {
                            noid: true,
                            client,
                            pk_name,
                          });
                        } catch (e) {
                          console.log(e);

                          if (
                            !((e as ErrorObj)?.message || "").includes(
                              "current transaction is aborted, commands ignored until end of transaction"
                            )
                          )
                            rejectDetails += `Reject row ${i} because: ${(e as ErrorObj)?.message}\n`;
                          rejects += 1;
                        }
                    } else if (options?.no_table_write) {
                      returnedRows.push(rec);
                    } else
                      try {
                        // TODO check constraints???
                        await db.insert(this.name, rec, {
                          noid: true,
                          client,
                          pk_name,
                        });
                      } catch (e: any) {
                        rejectDetails += `Reject row ${i} because: ${(e as ErrorObj)?.message}\n`;
                        rejects += 1;
                      }
                  } else {
                    rejectDetails += `Reject row ${i} because: ${rowOk}\n`;
                    rejects += 1;
                  }
                } catch (e) {
                  if (!options?.no_transaction) await client.query("ROLLBACK");

                  if (!db.isSQLite && !options?.no_transaction)
                    await client.release(true);
                  if (e instanceof Error)
                    reject({ error: `${e.message} in row ${i}` });
                }
              },
              (err: Error) => {
                reject({ error: !err ? err : err.message || err });
              },
              () => {
                resolve();
              }
            );
        });
        readStream.destroy();
      }
    } catch (e) {
      return {
        error: `Error processing CSV file: ${!e ? e : (e as ErrorObj).error || (e as ErrorObj).message || e}
${rejectDetails}`,
      };
    }

    if (rejectDetails)
      state.log(6, `CSV import rejectDetails: ` + rejectDetails);

    // stop sql transaction
    if (!options?.no_transaction) await client.query("COMMIT");

    if (!db.isSQLite && !options?.no_transaction) await client.release(true);

    if (options?.no_table_write) {
      return {
        success:
          `Found ${i > 1 ? i - 1 - rejects : ""} rows for table ${this.name}` +
          (rejects ? `. Rejected ${rejects} rows.` : ""),
        details: rejectDetails,
        rows: returnedRows,
      };
    }
    // reset id sequence
    await this.resetSequence();
    // recalculate fields
    if (
      options?.recalc_stored &&
      this.fields &&
      this.fields.some((f) => f.calculated && f.stored)
    ) {
      await recalculate_for_stored(this);
    }
    return {
      details: rejectDetails,
      success:
        `Imported ${i > 1 ? i - 1 - rejects : ""} rows into table ${
          this.name
        }` + (rejects ? `. Rejected ${rejects} rows.` : ""),
    };
  }

  stringify_json_fields(v1: Row) {
    if (db.isSQLite) return;
    this.fields
      .filter((f) => typeof f.type !== "string" && f?.type?.name === "JSON")
      .forEach((f) => {
        if (typeof v1[f.name] !== "undefined")
          v1[f.name] = JSON.stringify(v1[f.name]);
      });
  }
  parse_json_fields(v1: Row): Row {
    if (db.isSQLite)
      this.fields
        .filter((f) => typeof f.type !== "string" && f?.type?.name === "JSON")
        .forEach((f) => {
          if (typeof v1[f.name] === "string")
            try {
              v1[f.name] = JSON.parse(v1[f.name]);
            } catch (e) {}
        });
    return v1;
  }

  async import_json_history_file(filePath: string) {
    return await async_json_stream(filePath, async (row: Row) => {
      await this.insert_history_row(row);
    });
  }

  /**
   * Import JSON table description
   * @param filePath
   * @param skip_first_data_row
   * @returns {Promise<{error: string}|{success: string}>}
   */
  async import_json_file(
    filePath: string,
    skip_first_data_row?: boolean
  ): Promise<ResultMessage> {
    const fields = this.fields;
    const pk_name = this.pk_name;
    const { readState } = require("../plugin-helper");
    const jsonFields = fields.filter(
      (f) => typeof f.type !== "string" && f?.type?.name === "JSON"
    );
    let i = 1;
    let importError: string | undefined;
    const client = db.isSQLite ? db : await db.getClient();
    await client.query("BEGIN");
    const consume = async (rec: Row) => {
      i += 1;
      if (skip_first_data_row && i === 2) return;
      if (importError) return;
      fields
        .filter((f) => f.calculated && !f.stored)
        .forEach((f) => {
          if (typeof rec[f.name] !== "undefined") {
            delete rec[f.name];
          }
        });

      try {
        readState(rec, fields);
        jsonFields.forEach((f) => {
          if (!db.isSQLite && typeof rec[f.name] !== "undefined")
            rec[f.name] = JSON.stringify(rec[f.name]);
        });
        if (this.name === "users" && rec.role_id < 11 && rec.role_id > 1)
          rec.role_id = rec.role_id * 10;
        await db.insert(this.name, rec, { noid: true, client, pk_name });
      } catch (e) {
        await client.query("ROLLBACK");

        if (!db.isSQLite) await client.release(true);
        importError = `${(e as ErrorObj).message} in row ${i}`;
      }
    };
    await async_json_stream(filePath, async (row: Row) => {
      await consume(row);
    });
    if (importError) return { error: importError };

    await client.query("COMMIT");
    if (!db.isSQLite) await client.release(true);

    await this.resetSequence();

    return {
      success: `Imported ${i - 1} rows into table ${this.name}`,
    };
  }

  /**
   * get join-field-options joined from a field in this table
   * @param allow_double
   * @param allow_triple
   * @returns
   */
  async get_join_field_options(
    allow_double?: boolean,
    allow_triple?: boolean
  ): Promise<JoinFieldOption[]> {
    const fields = this.fields;
    const result = [];
    for (const f of fields) {
      if (f.is_fkey && f.type !== "File") {
        const table = Table.findOne({ name: f.reftable_name });
        if (!table) throw new Error(`Unable to find table '${f.reftable_name}`);
        table.getFields();
        if (!table.fields)
          throw new Error(`The table '${f.reftable_name} has no fields.`);
        const subOne = {
          name: f.name,
          table: table.name,
          subFields: new Array<any>(),
          fieldPath: f.name,
        };
        for (const pf of table.fields.filter(
          (f: Field) => !f.calculated || f.stored
        )) {
          const subTwo: SubField = {
            name: pf.name,
            subFields: new Array<any>(),
            fieldPath: `${f.name}.${pf.name}`,
          };
          if (pf.is_fkey && pf.type !== "File" && allow_double) {
            const table1 = Table.findOne({ name: pf.reftable_name });
            if (!table1)
              throw new Error(`Unable to find table '${pf.reftable_name}`);
            await table1.getFields();
            subTwo.table = table1.name;
            if (!table1.fields)
              throw new Error(`The table '${pf.reftable_name} has no fields.`);
            if (table1.fields)
              for (const gpf of table1.fields.filter(
                (f: Field) => !f.calculated || f.stored
              )) {
                const subThree: SubField = {
                  name: gpf.name,
                  subFields: new Array<any>(),
                  fieldPath: `${f.name}.${pf.name}.${gpf.name}`,
                };
                if (allow_triple && gpf.is_fkey && gpf.type !== "File") {
                  const gpfTbl = Table.findOne({
                    name: gpf.reftable_name,
                  });
                  if (gpfTbl) {
                    subThree.table = gpfTbl.name;
                    const gpfFields = await gpfTbl.getFields();
                    for (const ggpf of gpfFields.filter(
                      (f: Field) => !f.calculated || f.stored
                    )) {
                      subThree.subFields.push({
                        name: ggpf.name,
                        fieldPath: `${f.name}.${pf.name}.${gpf.name}.${ggpf.name}`,
                      });
                    }
                  }
                }
                subTwo.subFields.push(subThree);
              }
          }
          subOne.subFields.push(subTwo);
        }
        result.push(subOne);
      }
    }
    return result;
  }

  /**
   * get relation-options joined from a field of another table
   * @returns
   */
  async get_relation_options(): Promise<RelationOption[]> {
    return await Promise.all(
      (await this.get_relation_data()).map(
        async ({ relationTable, relationField }: RelationData) => {
          const path = `${relationTable.name}.${relationField.name}`;
          const relFields = await relationTable.getFields();
          const names = relFields
            .filter((f: Field) => f.type !== "Key")
            .map((f: Field) => f.name);
          return { relationPath: path, relationFields: names };
        }
      )
    );
  }

  /**
   * get relation-data joined from a field of another table
   * @returns
   */
  async get_relation_data(unique = true): Promise<RelationData[]> {
    const result = new Array<RelationData>();
    const o2o_rels = await Field.find(
      {
        reftable_name: this.name,
        is_unique: unique,
      },
      { cached: true }
    );
    for (const field of o2o_rels) {
      const relTbl = Table.findOne({ id: field.table_id });
      if (relTbl) result.push({ relationTable: relTbl, relationField: field });
    }
    return result;
  }

  /**
   * Get parent relations for table
   * @param allow_double
   * @param allow_triple
   * @returns {Promise<{parent_relations: object[], parent_field_list: object[]}>}
   */
  async get_parent_relations(
    allow_double?: boolean,
    allow_triple?: boolean
  ): Promise<ParentRelations> {
    const fields = this.fields;
    let parent_relations = [];
    let parent_field_list = [];
    for (const f of fields) {
      if (f.is_fkey && f.type !== "File") {
        const table = Table.findOne({ name: f.reftable_name });
        if (!table) throw new Error(`Unable to find table '${f.reftable_name}`);
        table.getFields();
        if (!table.fields)
          throw new Error(`The table '${f.reftable_name} has no fields.`);

        for (const pf of table.fields.filter(
          (f: Field) => !f.calculated || f.stored
        )) {
          parent_field_list.push(`${f.name}.${pf.name}`);
          if (pf.is_fkey && pf.type !== "File" && allow_double) {
            const table1 = Table.findOne({ name: pf.reftable_name });
            if (!table1)
              throw new Error(`Unable to find table '${pf.reftable_name}`);
            await table1.getFields();
            if (!table1.fields)
              throw new Error(`The table '${pf.reftable_name} has no fields.`);
            if (table1.fields)
              for (const gpf of table1.fields.filter(
                (f: Field) => !f.calculated || f.stored
              )) {
                parent_field_list.push(`${f.name}.${pf.name}.${gpf.name}`);
                if (allow_triple && gpf.is_fkey && gpf.type !== "File") {
                  const gpfTbl = Table.findOne({
                    name: gpf.reftable_name,
                  });
                  if (gpfTbl) {
                    const gpfFields = await gpfTbl.getFields();
                    for (const ggpf of gpfFields.filter(
                      (f: Field) => !f.calculated || f.stored
                    )) {
                      parent_field_list.push(
                        `${f.name}.${pf.name}.${gpf.name}.${ggpf.name}`
                      );
                    }
                  }
                }
              }

            parent_relations.push({ key_field: pf, through: f, table: table1 });
          }
        }
        parent_relations.push({ key_field: f, table });
      }
    }
    const o2o_rels = await Field.find(
      {
        reftable_name: this.name,
        is_unique: true,
      },
      { cached: true }
    );
    for (const relation of o2o_rels) {
      const related_table = Table.findOne({ id: relation.table_id });
      if (related_table) {
        const relfields = await related_table.getFields();
        for (const relfield of relfields) {
          parent_field_list.push(
            `${related_table.name}.${relation.name}->${relfield.name}`
          );
          parent_relations.push({
            key_field: relation,
            ontable: related_table,
          });
        }
      }
    }

    return { parent_relations, parent_field_list };
  }

  async field_options(
    nrecurse: number = 0,
    fieldWhere: (f: Field) => boolean = () => true,
    prefix: string = ""
  ): Promise<string[]> {
    const fields = this.fields;
    const these = fields.filter(fieldWhere).map((f) => prefix + f.name);
    const those: string[] = [];
    if (nrecurse > 0)
      for (const field of fields) {
        if (field.is_fkey) {
          const thatTable = Table.findOne({ name: field.reftable_name });
          if (thatTable) {
            those.push(
              ...(await thatTable.field_options(
                nrecurse - 1,
                fieldWhere,
                prefix + field.name + "."
              ))
            );
          }
        }
      }
    return [...these, ...those];
  }

  /**
   * Get child relations for table
   * @returns {Promise<{child_relations: object[], child_field_list: object[]}>}
   */
  async get_child_relations(
    allow_join_aggregations?: boolean
  ): Promise<ChildRelations> {
    const cfields = await Field.find(
      { reftable_name: this.name },
      { cached: true }
    );
    let child_relations = [];
    let child_field_list = [];
    for (const f of cfields) {
      if (f.is_fkey) {
        const table = Table.findOne({ id: f.table_id });
        if (!table) {
          throw new Error(`Unable to find table with id: ${f.table_id}`);
        }
        child_field_list.push(`${table.name}.${f.name}`);
        table.getFields();
        child_relations.push({ key_field: f, table });
      }
    }
    if (allow_join_aggregations) {
      const fields = this.fields;
      for (const f of fields) {
        if (f.is_fkey && f.type !== "File") {
          const refTable = Table.findOne({ name: f.reftable_name });
          if (!refTable)
            throw new Error(`Unable to find table '${f.reftable_name}`);

          const join_crels = await refTable.get_child_relations(false);
          join_crels.child_relations.forEach(({ key_field, table }) => {
            child_field_list.push(`${f.name}->${table.name}.${key_field.name}`);
            child_relations.push({ key_field, table, through: f });
          });
        }
      }
    }
    return { child_relations, child_field_list };
  }

  /**
   * Returns aggregations for this table, possibly on a subset by where-expression
   */
  async aggregationQuery(
    aggregations: {
      [nm: string]: {
        field?: string;
        valueFormula?: string;
        aggregate: string;
      };
    },
    options?: {
      where?: Where;
      groupBy?: string[] | string;
    }
  ): Promise<Row> {
    let fldNms: string[] = [];
    const where0 = options?.where || {};
    const groupBy = Array.isArray(options?.groupBy)
      ? options?.groupBy
      : options?.groupBy
        ? [options?.groupBy]
        : null;
    const schema = db.getTenantSchemaPrefix();
    const { where, values } = mkWhere(where0, db.isSQLite);

    Object.entries(aggregations).forEach(
      ([nm, { field, valueFormula, aggregate }]) => {
        if (
          field &&
          (aggregate.startsWith("Percent ") || aggregate.startsWith("Percent "))
        ) {
          const targetBoolVal = aggregate.split(" ")[1] === "true";

          fldNms.push(
            `avg( CASE WHEN "${sqlsanitize(field)}"=${JSON.stringify(
              !!targetBoolVal
            )} THEN 100.0 ELSE 0.0 END) as "${sqlsanitize(nm)}"`
          );
        } else if (
          field &&
          (aggregate.startsWith("Latest ") || aggregate.startsWith("Earliest "))
        ) {
          const dateField = aggregate.split(" ")[1];
          const isLatest = aggregate.startsWith("Latest ");

          let newWhere = where;
          if (groupBy) {
            const newClauses = groupBy
              .map((f) => `innertbl."${f}" = a."${f}"`)
              .join(" AND ");
            if (!newWhere) newWhere = "where " + newClauses;
            else newWhere = `${newWhere} AND ${newClauses}`;
          }
          fldNms.push(
            `(select ${
              field ? `"${sqlsanitize(field)}"` : valueFormula
            } from ${schema}"${sqlsanitize(
              this.name
            )}" innertbl ${newWhere} order by "${sqlsanitize(dateField)}" ${
              isLatest ? "DESC" : "ASC"
            } limit 1) as "${sqlsanitize(nm)}"`
          );
        } else
          fldNms.push(
            `${getAggAndField(
              aggregate,
              field === "Formula" ? undefined : field,
              field === "Formula" ? valueFormula : undefined
            )} as "${sqlsanitize(nm)}"`
          );
      }
    );
    if (groupBy) {
      fldNms.push(...groupBy);
    }

    const sql = `SELECT ${fldNms.join()} FROM ${schema}"${sqlsanitize(
      this.name
    )}" a ${where}${
      groupBy
        ? ` group by ${groupBy.map((f) => sqlsanitize(f)).join(", ")}`
        : ""
    }`;

    const res = await db.query(sql, values);
    if (groupBy) return res.rows;
    return res.rows[0];
  }

  ownership_formula_where(user: AbstractUser) {
    if (!this.ownership_formula) return {};
    const wh = jsexprToWhere(this.ownership_formula, { user }, this.fields);
    if (wh.eq && Array.isArray(wh.eq)) {
      let arr = wh.eq as any[];
      for (let index = 0; index < arr.length; index++) {
        const element = arr[index];
        if (typeof element === "symbol") {
          const field = this.getField((element as any).description!);
          if (field) {
            wh[field!.name] = arr[arr.length - index - 1];
            delete wh.eq;
          }
        }
      }
    }
    const isConstant = (x: unknown) =>
      ["string", "number", "boolean"].includes(typeof x);
    //TODO user groups
    if (wh.eq && !wh.eq.every(isConstant)) return {};
    return wh;
  }

  /**
   *
   * @param opts
   * @returns {Promise<{values, sql: string}>}
   */
  async getJoinedQuery(
    opts: (JoinOptions & ForUserRequest) | any = {}
  ): Promise<
    Partial<JoinOptions> & {
      sql?: string;
      values?: Value[];
      notAuthorized?: boolean;
    }
  > {
    const fields = this.fields;
    let fldNms = [];
    let joinq = "";
    let joinTables: string[] = [];
    let joinFields: JoinFields = opts.joinFields || {};
    let aggregations = opts.aggregations || {};
    const schema = db.getTenantSchemaPrefix();
    const { forUser, forPublic } = opts;
    const role = forUser ? forUser.role_id : forPublic ? 100 : null;
    if (role && role > this.min_role_read && this.ownership_formula) {
      const freeVars = freeVariables(this.ownership_formula);
      add_free_variables_to_joinfields(freeVars, joinFields, fields);
    }
    if (role && role > this.min_role_read && this.ownership_field_id) {
      if (forPublic) return { notAuthorized: true };
      const owner_field = fields.find((f) => f.id === this.ownership_field_id);
      if (!owner_field)
        throw new Error(`Owner field in table ${this.name} not found`);
      if (!opts.where) opts.where = {};
      mergeIntoWhere(opts.where, {
        [owner_field.name]: (forUser as AbstractUser).id,
      });
    } else if (role && role > this.min_role_read && this.ownership_formula) {
      if (!opts.where) opts.where = {};
      if (forPublic || role === 100) return { notAuthorized: true }; //TODO may not be true
      try {
        mergeIntoWhere(opts.where, this.ownership_formula_where(forUser));
      } catch (e) {
        //ignore, ownership formula is too difficult to merge with where
        // TODO user groups
      }
    }

    for (const [fldnm, { ref, target, through, ontable }] of Object.entries(
      joinFields
    )) {
      let reffield;
      if (ontable) {
        const ontableTbl = Table.findOne({ name: ontable });
        if (!ontableTbl)
          throw new InvalidConfiguration(
            `Related table ${ontable} not found in table ${this.name}`
          );
        reffield = (await ontableTbl.getFields()).find((f) => f.name === ref);
      } else {
        reffield = fields.find((f) => f.name === ref);
      }
      if (!reffield)
        throw new InvalidConfiguration(
          `Key field ${ref} not found in table ${this.name}`
        );
      const reftable = ontable || reffield.reftable_name;
      if (!reftable)
        throw new InvalidConfiguration(`Field ${ref} is not a key field`);
      const jtNm = `${sqlsanitize(reftable)}_jt_${sqlsanitize(ref)}`;
      if (!joinTables.includes(jtNm)) {
        joinTables.push(jtNm);
        if (ontable)
          joinq += `\n left join ${schema}"${sqlsanitize(
            reftable
          )}" "${jtNm}" on "${jtNm}"."${sqlsanitize(ref)}"=a."${reffield.refname}"`;
        else
          joinq += `\n left join ${schema}"${sqlsanitize(
            reftable
          )}" "${jtNm}" on "${jtNm}"."${reffield.refname}"=a."${sqlsanitize(ref)}"`;
      }
      if (through) {
        const throughs = Array.isArray(through) ? through : [through];
        let last_reffield = reffield;
        let jtNm1;
        let lastJtNm = jtNm;
        for (let i = 0; i < throughs.length; i++) {
          const through1 = throughs[i];
          const throughPath = throughs.slice(0, i + 1);
          const throughTable = Table.findOne({
            name: last_reffield.reftable_name,
          });
          if (!throughTable)
            throw new InvalidConfiguration(
              `Join-through table ${last_reffield.reftable_name} not found`
            );
          const throughTableFields = await throughTable.getFields();
          const throughRefField = throughTableFields.find(
            (f: Field) => f.name === through1
          );
          if (!throughRefField)
            throw new InvalidConfiguration(
              `Reference field field ${through} not found in table ${throughTable.name}`
            );
          const finalTable = throughRefField.reftable_name;
          const finalTableObj = Table.findOne({ name: finalTable });
          jtNm1 = `${sqlsanitize(
            last_reffield.reftable_name as string
          )}_jt_${sqlsanitize(throughPath.join("_"))}_jt_${sqlsanitize(ref)}`;

          if (!joinTables.includes(jtNm1)) {
            if (!finalTable)
              throw new Error(
                "Unable to build a joind without a reftable_name."
              );
            joinTables.push(jtNm1);
            joinq += `\n left join ${schema}"${sqlsanitize(
              finalTable
            )}" "${jtNm1}" on "${jtNm1}"."${finalTableObj!.pk_name}"="${lastJtNm}"."${sqlsanitize(through1)}"`;
          }

          last_reffield = throughRefField;
          lastJtNm = jtNm1;
        }
        // todo warning variable might not have been initialized
        fldNms.push(
          `"${jtNm1}"."${sqlsanitize(target)}" as "${sqlsanitize(fldnm)}"`
        );
      } else {
        fldNms.push(
          `"${jtNm}"."${sqlsanitize(target)}" as "${sqlsanitize(fldnm)}"`
        );
      }
    }
    if (opts.starFields) fldNms.push("a.*");
    else
      for (const f of fields.filter((f) => !f.calculated || f.stored)) {
        if (!opts.fields || opts.fields.includes(f.name))
          fldNms.push(`a."${sqlsanitize(f.name)}"`);
      }
    const whereObj = prefixFieldsInWhere(opts.where, "a");
    const { where, values } = mkWhere(whereObj, db.isSQLite);

    process_aggregations(this, aggregations, fldNms, values, schema);

    const odbUnderscore =
      typeof opts.orderBy === "string" ? opts.orderBy.replace(/\./g, "_") : "";
    const selectopts: SelectOptions = this.processSelectOptions({
      limit: opts.limit,
      orderBy:
        opts.orderBy &&
        (orderByIsObject(opts.orderBy) || orderByIsOperator(opts.orderBy)
          ? opts.orderBy
          : joinFields[opts.orderBy] || aggregations[opts.orderBy]
            ? opts.orderBy
            : joinFields[odbUnderscore]
              ? odbUnderscore
              : opts.orderBy.toLowerCase?.() === "random()"
                ? opts.orderBy
                : "a." + opts.orderBy),
      orderDesc: opts.orderDesc,
      offset: opts.offset,
    });

    const sql = `SELECT ${fldNms.join()} FROM ${schema}"${sqlsanitize(
      this.name
    )}" a ${joinq} ${where}  ${mkSelectOptions(
      selectopts,
      values,
      db.is_sqlite
    )}`;

    return { sql, values, joinFields, aggregations };
  }

  /**
   * @param {object} [opts = {}]
   * @returns {Promise<object[]>}
   */
  async getJoinedRow(
    opts: (JoinOptions & ForUserRequest) | any = {}
  ): Promise<Row | null> {
    const rows = await this.getJoinedRows(opts);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Get rows along with joined and aggregated fields. The argument to `getJoinedRows` is an object
   * with several different possible fields, all of which are optional
   *
   * * `where`: A Where expression indicating the criterion to match
   * * `joinFields`: An object with the joinfields to retrieve
   * * `aggregations`: An object with the aggregations to retrieve
   * * `orderBy`: A string with the name of the field to order by
   * * `orderDesc`: If true, descending order
   * * `limit`: A number with the maximum number of rows to retrieve
   * * `offset`: The number of rows to skip in the result before returning rows
   *
   * @example
   * ```
   * const patients = Table.findOne({ name: "patients" });
   * const patients_rows = await patients.getJoinedRows({
   *      where: { age: { gt: 65 } },
   *      orderBy: "id",
   *      aggregations: {
   *        avg_temp: {
   *          table: "readings",
   *          ref: "patient_id",
   *          field: "temperature",
   *          aggregate: "avg",
   *       },
   *      },
   *      joinFields: {
   *        pages: { ref: "favbook", target: "pages" },
   *        author: { ref: "favbook", target: "author" },
   *      },
   * });
   * ```
   *
   * @param {object} [opts = {}]
   * @returns {Promise<object[]>}
   */
  async getJoinedRows(
    opts: (JoinOptions & ForUserRequest) | any = {}
  ): Promise<Array<Row>> {
    const fields = this.fields;
    const { forUser, forPublic, ...selopts1 } = opts;
    const role = forUser ? forUser.role_id : forPublic ? 100 : null;
    const { sql, values, notAuthorized, joinFields, aggregations } =
      await this.getJoinedQuery(opts);

    if (notAuthorized) return [];
    const res = await db.query(sql as string, values);
    if (res.rows?.length === 0) return []; // check
    let calcRow = apply_calculated_fields(
      res.rows.map((row: Row) => this.parse_json_fields(row)),
      fields,
      !!opts?.ignore_errors
    );
    //need to json parse array agg values on sqlite
    if (
      db.isSQLite &&
      Object.values(aggregations || {}).some(
        (agg) => agg.aggregate.toLowerCase() === "array_agg"
      )
    ) {
      Object.entries(aggregations || {}).forEach(([k, agg]: any) => {
        if (agg.aggregate.toLowerCase() === "array_agg") {
          calcRow.forEach((row) => {
            if (row[k]) row[k] = JSON.parse(row[k]);
          });
        }
      });
    }
    //rename aggregations and joinfields
    if (
      Object.values(joinFields || {}).some((jf: any) => jf.rename_object) ||
      Object.values(aggregations || {}).some((jf: any) => jf.rename_to)
    ) {
      let f = (x: any) => x;
      Object.entries(aggregations || {}).forEach(([k, v]: any) => {
        if (v.rename_to) {
          const oldf = f;
          f = (x: any) => {
            if (typeof x[k] !== "undefined") {
              x[v.rename_to] = x[k];
              delete x[k];
            }
            return oldf(x);
          };
        }
      });
      Object.entries(joinFields || {}).forEach(([k, v]: any) => {
        if (v.rename_object) {
          if (v.rename_object.length === 2) {
            const oldf = f;
            f = (x: any) => {
              const origId = x[v.rename_object[0]];
              x[v.rename_object[0]] = {
                ...x[v.rename_object[0]],
                [v.rename_object[1]]: x[k],
                ...(typeof origId === "number" ? { id: origId } : {}),
              };
              return oldf(x);
            };
          } else if (v.rename_object.length === 3) {
            const oldf = f;
            f = (x: any) => {
              const origId = x[v.rename_object[0]];
              x[v.rename_object[0]] = {
                ...x[v.rename_object[0]],
                [v.rename_object[1]]: {
                  ...x[v.rename_object[0]]?.[v.rename_object[1]],
                  [v.rename_object[2]]: x[k],
                },
                ...(typeof origId === "number" ? { id: origId } : {}),
              };
              return oldf(x);
            };
          } else if (v.rename_object.length === 4) {
            const oldf = f;
            f = (x: any) => {
              const origId = x[v.rename_object[0]];

              x[v.rename_object[0]] = {
                ...x[v.rename_object[0]],
                [v.rename_object[1]]: {
                  ...x[v.rename_object[0]]?.[v.rename_object[1]],
                  [v.rename_object[2]]: {
                    ...x[v.rename_object[0]]?.[v.rename_object[1]]?.[
                      v.rename_object[2]
                    ],
                    [v.rename_object[3]]: x[k],
                  },
                },
                ...(typeof origId === "number" ? { id: origId } : {}),
              };

              return oldf(x);
            };
          }
        }
      });

      calcRow = calcRow.map(f);
    }

    if (role && role > this.min_role_read) {
      //check ownership
      if (forPublic) return [];
      else if (this.ownership_field_id) {
        //already dealt with by changing where
      } else if (this.ownership_formula || this.name === "users") {
        calcRow = calcRow.filter((row: Row) => this.is_owner(forUser, row));
      } else return []; //no ownership
    }
    return calcRow;
  }

  /**
   *
   */
  async slug_options(): Promise<
    Array<{ label: string; steps: Array<SlugStepType> }>
  > {
    const fields = this.fields;
    const unique_fields = fields.filter((f) => f.is_unique);
    const opts: Array<{ label: string; steps: Array<SlugStepType> }> = [];
    unique_fields.forEach((f: Field) => {
      const label =
        instanceOfType(f.type) && f.type.name === "String"
          ? `/slugify-${f.name}`
          : `/:${f.name}`;
      opts.push({
        label,
        steps: [
          {
            field: f.name,
            unique: true,
            transform:
              instanceOfType(f.type) && f.type.name === "String"
                ? "slugify"
                : null,
          },
        ],
      });
    });
    opts.unshift({ label: "", steps: [] });
    return opts;
  }

  /**
   *
   */
  static async allSlugOptions(): Promise<{
    [nm: string]: Array<{ label: string; steps: Array<SlugStepType> }>;
  }> {
    const tables = await Table.find({}, { cached: true });
    const options: {
      [nm: string]: Array<{ label: string; steps: Array<SlugStepType> }>;
    } = {};
    for (const table of tables) {
      options[table.name] = await table.slug_options();
    }
    return options;
  }

  /**
   *
   */
  async getTags(): Promise<Array<AbstractTag>> {
    const Tag = (await import("./tag")).default;
    return await Tag.findWithEntries({ table_id: this.id });
  }

  /**
   *
   */
  async getForeignTables(): Promise<Array<AbstractTable>> {
    const result = new Array<AbstractTable>();
    if (this.fields) {
      for (const field of this.fields) {
        if (field.is_fkey) {
          const refTable = Table.findOne({ name: field.reftable_name! });
          if (refTable) result.push(refTable);
        }
      }
    }
    return result;
  }

  getFormulaExamples(typename: string) {
    return get_formula_examples(
      typename,
      this.fields.filter((f) => !f.calculated)
    );
  }
  async repairCompositePrimary() {
    const primaryKeys = this.fields.filter((f) => f.primary_key);
    const nonSerialPKS = primaryKeys.some((f) => f.attributes?.NonSerial);
    const schemaPrefix = db.getTenantSchemaPrefix();
    if (primaryKeys.length == 0) {
      await db.query(
        `alter table ${schemaPrefix}"${this.name}" add column id serial primary key;`
      );
      await db.query(
        `insert into ${schemaPrefix}_sc_fields(table_id, name, label, type, attributes, required, is_unique,primary_key)
        values($1,'id','ID','Integer', '{}', true, true, true) returning id`,
        [this.id]
      );
    } else if (primaryKeys.length > 1) {
      const { rows } = await db.query(`select constraint_name
from information_schema.table_constraints
where table_schema = '${db.getTenantSchema() || "public"}'
      and table_name = '${this.name}'
      and constraint_type = 'PRIMARY KEY';`);
      const cname = rows[0]?.constraint_name;
      await db.query(
        `alter table ${schemaPrefix}"${this.name}" drop constraint "${cname}"`
      );
      for (const field of this.fields) {
        if (field.primary_key) await field.update({ primary_key: false });
      }
      const { pk_type, pk_sql_type } = Table.pkSqlType(this.fields);

      await db.query(
        `alter table ${schemaPrefix}"${this.name}" add column id ${pk_sql_type} primary key;`
      );
      await db.query(
        `insert into ${schemaPrefix}_sc_fields(table_id, name, label, type, attributes, required, is_unique,primary_key)
        values($1,'id','ID','${pk_type}', '{}', true, true, true) returning id`,
        [this.id]
      );
    } else if (nonSerialPKS) {
      //https://stackoverflow.com/questions/23578427/changing-primary-key-int-type-to-serial
      await db.query(`CREATE SEQUENCE ${schemaPrefix}"${this.name}_id_seq";`);
      await db.query(
        `ALTER SEQUENCE ${schemaPrefix}"${this.name}_id_seq" OWNED BY ${schemaPrefix}"${this.name}"."${this.pk_name}"`
      );
      await db.query(
        `SELECT setval('${schemaPrefix}"${this.name}_id_seq"', MAX(a."${this.pk_name}")) from ${schemaPrefix}"${this.name}" a`
      );
      await db.query(
        `ALTER TABLE ${schemaPrefix}"${this.name}" ALTER COLUMN "${this.pk_name}" SET DEFAULT nextval('${schemaPrefix}"${this.name}_id_seq"')`
      );
      const pk = this.getField(this.pk_name)!;
      const attrs = { ...pk.attributes };
      delete attrs.NonSerial;
      await pk.update({ attributes: attrs });
    }
    //limited refresh if we do not have a client
    if (!db.getRequestContext()?.client)
      await require("../db/state").getState().refresh_tables(true);
  }

  async move_include_fts_to_search_context() {
    const include_fts_fields = this.fields.filter(
      (f: Field) => f.attributes?.include_fts
    );
    if (!include_fts_fields.length) return;
    let expressions: string[] = [];
    for (const ftsfield of include_fts_fields)
      expressions.push(
        `${ftsfield.name}?.${ftsfield?.attributes?.summary_field || "id"}||""`
      );
    const existing_ctx_field = this.getField("search_context");
    if (
      existing_ctx_field &&
      existing_ctx_field.stored &&
      existing_ctx_field.expression
    ) {
      await existing_ctx_field.update({
        expression:
          existing_ctx_field.expression +
          ' + " " + ' +
          expressions.join(' + " " + '),
      });
    } else {
      await Field.create({
        table: this,
        label: "Search context",
        name: "search_context",
        type: "String",
        calculated: true,
        expression: expressions.join(' + " " + '),
        stored: true,
      });
    }
    for (const ftsfield of this.fields)
      if (ftsfield.attributes?.include_fts) {
        ftsfield.attributes.include_fts = false;
        await ftsfield.update({
          attributes: ftsfield.attributes,
        });
      }
  }
}

async function dump_table_to_json_file(filePath: string, tableName: string) {
  const writeStream = createWriteStream(filePath);
  const client = db.isSQLite ? db : await db.getClient();
  writeStream.write("[");
  db.copyToJson && (await db.copyToJson(writeStream, tableName, client));
  if (!db.isSQLite) await client.release(true);
  writeStream.destroy();
  const h = await open(filePath, "r+");
  const stat = await h.stat();
  if (stat.size > 2) await h.write("]", stat.size - 2);
  else await h.write("]", stat.size);
  await h.close();
}

// declaration merging
namespace Table {
  export type ParentRelations = {
    parent_relations: {
      key_field: Field;
      table?: Table;
      ontable?: Table;
    }[];
    parent_field_list: string[];
  };

  export type ChildRelations = {
    child_relations: {
      key_field: Field;
      table: Table;
    }[];
    child_field_list: string[];
  };

  export type RelationData = {
    relationTable: Table;
    relationField: Field;
  };
}

type ParentRelations = Table.ParentRelations;
type ChildRelations = Table.ChildRelations;
type RelationData = Table.RelationData;

export = Table;
