/**
 * This is the saltcorn-markup package
 * @module
 */
import renderFormModule = require("./form");
const { renderForm, mkFormContentNoLayout, mkForm, renderFormLayout } =
  renderFormModule;
import renderBuilder = require("./builder");
import mkTable = require("./table");
import tabs = require("./tabs");
import tags = require("./tags");
import helpers = require("./helpers");
const { a, text, div, button, hr, time, i, input, text_attr, form, span } =
  tags;
import layoutUtils = require("./layout_utils");
const { alert, toast, show_icon_and_label, validID } = layoutUtils;

/**
 * @param {string} href
 * @param {string} s
 * @returns {string}
 */
const link = (href: string, s: string, attributes: any = {}): string =>
  a({ href: text(href), ...attributes }, text(s));

type PostBtnOpts = {
  btnClass: string;
  onClick?: string;
  small?: boolean;
  style?: string;
  ajax?: boolean;
  reload_on_done: string;
  reload_delay?: string;
  klass: string;
  formClass?: string;
  spinner?: boolean;
  req: any;
  confirm?: boolean;
  icon?: string;
  title?: string;
};

declare let window: any;

const buildButtonCallback = (
  reload_on_done: boolean,
  reload_delay?: number
): string => {
  const isNode = typeof window === "undefined";
  if (isNode) return `ajax_post_btn(this, ${reload_on_done}, ${reload_delay})`;
  else return "local_post_btn(this)";
};

/**
 * @param href
 * @param s
 * @param csrfToken
 * @param opts
 * @param opts.btnClass
 * @param opts.onClick
 * @param opts.small
 * @param opts.style
 * @param opts.ajax
 * @param opts.reload_on_done
 * @param opts.reload_delay
 * @param opts.klass
 * @param opts.formClass
 * @param opts.spinner
 * @param opts.req
 * @param opts.confirm
 * @param opts.icon
 * @returns
 */
const post_btn = (
  href: string,
  s: string,
  csrfToken: string,
  {
    btnClass = "btn-primary",
    onClick,
    small,
    style,
    ajax,
    reload_on_done,
    reload_delay,
    klass = "",
    formClass,
    spinner,
    req,
    confirm,
    icon,
    title,
  }: PostBtnOpts | any = {}
): string =>
  form(
    {
      action: text(href),
      method: "post",
      ...(formClass ? { class: formClass } : {}),
    },
    [
      ajax ? "" : input({ type: "hidden", name: "_csrf", value: csrfToken }),
      button(
        {
          ...(ajax ? { type: "button" } : { type: "submit" }),
          ...(onClick && ajax
            ? {
                onclick: `${spinner ? "spin_action_link(this);" : ""}${buildButtonCallback(
                  reload_on_done,
                  reload_delay
                )};${onClick}`,
              }
            : {
                ...(onClick
                  ? {
                      onclick: `${spinner ? "spin_action_link(this);" : ""}${onClick}`,
                    }
                  : {
                      ...(ajax && confirm
                        ? {
                            onclick: `if(confirm('${req.__("Are you sure?")}')) {${
                              spinner ? "spin_action_link(this);" : ""
                            }${buildButtonCallback(reload_on_done, reload_delay)}}`,
                          }
                        : {
                            ...(ajax
                              ? {
                                  onclick: `${spinner ? "spin_action_link(this);" : ""}${buildButtonCallback(
                                    reload_on_done,
                                    reload_delay
                                  )}`,
                                }
                              : {
                                  ...(confirm && spinner
                                    ? {
                                        onclick: `if(confirm('${req.__("Are you sure?")}')){spin_action_link(this);return truel}else return false`,
                                      }
                                    : confirm
                                      ? {
                                          onclick: `return confirm('${req.__("Are you sure?")}')`,
                                        }
                                      : {
                                          ...(spinner
                                            ? {
                                                onclick:
                                                  "spin_action_link(this);",
                                              }
                                            : {}),
                                        }),
                                }),
                          }),
                    }),
              }),
          class: `${klass} btn ${small ? "btn-sm" : ""} ${btnClass}`,
          ...(style ? { style } : {}),
          ...(title ? { title: text_attr(title) } : {}),
        },
        show_icon_and_label(icon, s)
      ),
    ]
  );

/**
 * UI Form for Delete Item confirmation
 * @param href - href
 * @param req - Request
 * @param what- Item
 * @returns return html form
 */
const post_delete_btn = (href: string, req: any, what?: string): string =>
  form(
    { action: text(href), method: "post" },
    input({ type: "hidden", name: "_csrf", value: req.csrfToken() }),
    button(
      {
        type: "submit",
        class: "btn btn-danger btn-sm",
        onclick: `return confirm('${
          what
            ? req.__("Are you sure you want to delete %s?", what)
            : req.__("Are you sure?")
        }')`,
      },
      i({ class: "fas fa-trash-alt" })
    )
  );

/**
 * @param href
 * @param s
 * @param req
 * @param confirm
 * @param what
 * @returns
 */
const post_dropdown_item = (
  href: string,
  s: string,
  req: any,
  confirm?: boolean,
  what?: string
): string => {
  const id = validID(
    href
      .split("/")
      .join("")
      .split(" ")
      .join("")
      .split("?")
      .join("")
      .split("=")
      .join("")
      .split("%")
      .join("")
  );

  const confirmationScript = confirm
    ? `if(confirm('${
        what
          ? req.__("Are you sure you want to delete %s?", what)
          : req.__("Are you sure?")
      }')) `
    : "";

  return [
    a(
      {
        class: "dropdown-item",
        onclick: `${confirmationScript}$('#${id}').submit()`,
      },
      s
    ),
    form(
      {
        id,
        action: text(href),
        method: "post",
      },
      [
        input({
          type: "hidden",
          name: "_csrf",
          value: req.csrfToken(),
        }),
      ]
    ),
  ].join("");
};

/**
 * @param id
 * @param elems
 * @returns
 */
const settingsDropdown = (id: string, elems: any): string =>
  div(
    { class: "dropdown" },
    button(
      {
        class: "btn btn-sm btn-outline-secondary",
        "data-boundary": "viewport",
        type: "button",
        id,
        "data-bs-toggle": "dropdown",
        "aria-haspopup": "true",
        "aria-expanded": "false",
      },
      i({ class: "fas fa-ellipsis-h" })
    ),
    div(
      {
        class: "dropdown-menu dropdown-menu-end",
        "aria-labelledby": id,
      },
      elems
    )
  );

/**
 * @param date
 * @param options
 * @returns
 */
const localeTime = (
  date: Date,
  options: any = { hour: "2-digit", minute: "2-digit" },
  locale: string = "en"
): string =>
  date
    ? time(
        {
          datetime: date.toISOString(),
          "locale-time-options": encodeURIComponent(JSON.stringify(options)),
        },
        date.toLocaleTimeString(locale || "en", options)
      )
    : "";

/**
 * @param date
 * @param options
 * @returns
 */
const localeDateTime = (
  date: Date,
  options: any = {},
  locale: string = "en"
): string =>
  date?.toISOString
    ? time(
        {
          datetime: date.toISOString(),
          "locale-options": encodeURIComponent(JSON.stringify(options)),
        },
        date.toLocaleString(locale || "en", options)
      )
    : "";

/**
 * @param date
 * @param options
 * @returns
 */
const localeDate = (
  date: Date,
  options: any = {},
  locale: string = "en"
): string =>
  date
    ? time(
        {
          datetime: date.toISOString(),
          "locale-date-options": encodeURIComponent(JSON.stringify(options)),
        },
        date.toLocaleDateString(locale || "en", options)
      )
    : "";

const badge = (col: string, lbl: string): string =>
  `${span({ class: `badge bg-${col}` }, lbl)}&nbsp;`;

export = {
  mkTable,
  badge,
  renderForm,
  mkFormContentNoLayout,
  mkForm,
  renderFormLayout,
  settingsDropdown,
  renderBuilder,
  link,
  post_btn,
  post_delete_btn,
  post_dropdown_item,
  tabs,
  localeTime,
  localeDate,
  localeDateTime,
  div,
  a,
  i,
  button,
  input,
  hr,
  tags,
  alert,
  toast,
  helpers,
};
